#define _GNU_SOURCE
#include "supervisor.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int text(const HfJson *j,int o,const char *k,char *v,size_t n){return hf_json_string(j,hf_json_field(j,o,k),v,n);}
static int absolute(const char *p){return p&&p[0]=='/'&&strlen(p)<4000&&!strstr(p,"//")&&!strstr(p,"/../")&&!strstr(p,"/./")&&strcmp(p+strlen(p)-1,"/");}
static int join(char out[4096],const char *a,const char *b){char value[4096];int n=snprintf(value,sizeof value,"%s/%s",a,b);if(n<=0||n>=4096)return 0;memcpy(out,value,(size_t)n+1);return 1;}
static int digest(const char *s){if(strlen(s)!=71||strncmp(s,"sha256:",7))return 0;for(size_t k=7;k<71;k++)if(!strchr("0123456789abcdef",s[k]))return 0;return 1;}
static int number(const char *s,unsigned long long *v){char *end=NULL;if(!s||!*s||strlen(s)>19)return 0;for(const char *p=s;*p;p++)if(*p<'0'||*p>'9')return 0;errno=0;*v=strtoull(s,&end,10);return !errno&&end&&!*end&&*v<=LLONG_MAX;}
static int safe_open(const char *path,int directory,int private_file){
 if(!absolute(path)){return -1;}char *copy=strdup(path),*save=NULL;if(!copy)return -1;
 int fd=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
 for(char *part=strtok_r(copy,"/",&save);fd>=0&&part;part=strtok_r(NULL,"/",&save)){
  int last=!save||!*save;if(!strcmp(part,".")||!strcmp(part,"..")){close(fd);fd=-1;break;}
  int next=openat(fd,part,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|((!last||directory)?O_DIRECTORY:O_NONBLOCK));struct stat st;close(fd);fd=next;
  if(fd<0){break;}if(fstat(fd,&st)||st.st_uid!=0||(st.st_mode&022)||((!last||directory)?!S_ISDIR(st.st_mode):(!S_ISREG(st.st_mode)||st.st_nlink!=1||(private_file&&(st.st_mode&077))))){close(fd);fd=-1;break;}
 }
 free(copy);return fd;
}
static int read_file(const char *path,const char *pin,size_t maximum,int private_file,char **raw,size_t *size){
 int fd=safe_open(path,0,private_file);struct stat a,b;if(fd<0)return 0;int ok=!fstat(fd,&a)&&a.st_size>=0&&(unsigned long long)a.st_size<=maximum;
 *raw=ok?malloc((size_t)a.st_size+1):NULL;if(!*raw)ok=0;size_t n=0;
 while(ok&&n<(size_t)a.st_size){ssize_t got=read(fd,*raw+n,(size_t)a.st_size-n);if(got<0&&errno==EINTR)continue;if(got<=0){ok=0;break;}n+=(size_t)got;}
 char extra;if(ok)ok=read(fd,&extra,1)==0&&!fstat(fd,&b)&&a.st_dev==b.st_dev&&a.st_ino==b.st_ino&&a.st_size==b.st_size&&a.st_mode==b.st_mode&&a.st_uid==b.st_uid&&a.st_gid==b.st_gid&&a.st_nlink==b.st_nlink&&a.st_mtim.tv_sec==b.st_mtim.tv_sec&&a.st_mtim.tv_nsec==b.st_mtim.tv_nsec&&a.st_ctim.tv_sec==b.st_ctim.tv_sec&&a.st_ctim.tv_nsec==b.st_ctim.tv_nsec;
 close(fd);char hash[65];if(ok&&pin)ok=digest(pin)&&hf_sha256_bytes(*raw,n,hash)&&!strcmp(hash,pin+7);
 if(!ok){free(*raw);*raw=NULL;return 0;}(*raw)[n]=0;*size=n;return 1;
}
static int pinned(const char *path,const char *pin){char *raw=NULL;size_t n=0;int ok=read_file(path,pin,4194304,0,&raw,&n);free(raw);return ok;}
static int private_dir(const char *path){char parent[4096];if(!absolute(path))return 0;strcpy(parent,path);char *slash=strrchr(parent,'/');if(!slash||slash==parent)return 0;*slash=0;int fd=safe_open(parent,1,0);if(fd<0)return 0;int ok=!mkdirat(fd,slash+1,0700)||errno==EEXIST;int child=ok?openat(fd,slash+1,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC):-1;struct stat st;ok=child>=0&&!fstat(child,&st)&&st.st_uid==0&&!(st.st_mode&022)&&!fchmod(child,0700)&&!fsync(child)&&!fsync(fd);if(child>=0)close(child);close(fd);return ok;}
static int identity(const HfJson *j,int o,HfProcessIdentity *p){int64_t pid=0,pgid=0;char start[32];unsigned long long value=0;memset(p,0,sizeof *p);if(o<0||!hf_json_i64(j,hf_json_field(j,o,"pid"),&pid)||pid<1||pid>INT_MAX||!hf_json_i64(j,hf_json_field(j,o,"pgid"),&pgid)||pgid<1||pgid>INT_MAX||!text(j,o,"start_time",start,sizeof start)||!number(start,&value)||!text(j,o,"os_boot_id",p->os_boot_id,sizeof p->os_boot_id)||!hf_uuid_valid(p->os_boot_id))return 0;p->pid=(pid_t)pid;p->pgid=(pid_t)pgid;p->start_time=value;return 1;}
static int equal_identity(const HfProcessIdentity *a,const HfProcessIdentity *b){return a->pid==b->pid&&a->pgid==b->pgid&&a->start_time==b->start_time&&!strcmp(a->os_boot_id,b->os_boot_id);}
static void stable_identity(FILE *s,const HfProcessIdentity *p){fprintf(s,"{\"pid\":%ld,\"pgid\":%ld,\"start_time\":\"%llu\",\"os_boot_id\":\"%s\"}",(long)p->pid,(long)p->pgid,p->start_time,p->os_boot_id);}
static int alive(const HfProcessIdentity *p){HfProcessIdentity actual={0};return hf_process_identity(p->pid,&actual)&&equal_identity(p,&actual)&&actual.uid==0&&actual.state!='Z'&&actual.state!='X';}
static void pause_tick(void){struct timespec delay={0,50000000};while(nanosleep(&delay,&delay)&&errno==EINTR){}}
static int pending_matches(const HfJson *state,const HfJson *permit,int wanted){
 int pending=hf_json_field(state,0,"pending");char *a=NULL,*b=NULL;int valid=1;const char *keys[]={"kind","operation_id","idempotency_key","correlation_id"};
 for(size_t k=0;valid&&k<4;k++){a=hf_json_raw(state,hf_json_field(state,pending,keys[k]));b=hf_json_raw(permit,hf_json_field(permit,wanted,keys[k]));valid=a&&b&&!strcmp(a,b);free(a);free(b);}
 int field=hf_json_field(state,pending,"payload");size_t cap=field>=0?(size_t)(state->tokens[field].end-state->tokens[field].start)+1:0;char *payload=cap?malloc(cap):NULL,expected[72],hash[65];
 valid=valid&&payload&&hf_json_string(state,field,payload,cap)&&text(permit,wanted,"payload_digest",expected,sizeof expected)&&digest(expected)&&hf_sha256_bytes(payload,strlen(payload),hash)&&!strcmp(expected+7,hash);free(payload);return valid;
}
static int state_progress(const char *path,unsigned long long before,char version[32]){char *raw=NULL;size_t n=0;HfJson *j=malloc(sizeof *j);int yes=0;unsigned long long current=0;int ok=j&&read_file(path,NULL,HF_BODY_LIMIT,1,&raw,&n)&&hf_json_parse(j,raw)&&hf_json_bool(j,hf_json_field(j,0,"registered"),&yes)&&yes&&text(j,0,"state_version",version,32)&&number(version,&current)&&current>before;free(j);free(raw);return ok;}
typedef struct {const HfJson *permit;const char *permit_pin,*bootstrap,*credential,*manifest_pin,*receipt_path,*state_path;HfProcessIdentity previous;unsigned long long before;} RecoveryProof;
static int finalize_receipt(const RecoveryProof *proof,const HfProcessIdentity *daemon,const HfProcessIdentity *monitor){
 char version[32];if(!alive(daemon)||!alive(monitor)||!state_progress(proof->state_path,proof->before,version))return 0;
 char *body=NULL;size_t size=0;FILE *s=open_memstream(&body,&size);if(!s)return 0;
 fprintf(s,"{\"schema_version\":1,\"kind\":\"FLEET_NATIVE_DAEMON_RECOVERY_RECEIPT_V1\",\"operation_id\":");char *operation=hf_json_raw(proof->permit,hf_json_field(proof->permit,0,"operation_id"));if(!operation){fclose(s);free(body);return 0;}fputs(operation,s);free(operation);
 fprintf(s,",\"bootstrap_id\":\"%s\",\"manifest_digest\":\"%s\",\"recovery_digest\":\"%s\",\"credential_id\":\"%s\",\"accepted_state_version\":\"%s\",\"previous_daemon\":",proof->bootstrap,proof->manifest_pin,proof->permit_pin,proof->credential,version);stable_identity(s,&proof->previous);fputs(",\"daemon\":",s);stable_identity(s,daemon);fputs(",\"monitor\":",s);stable_identity(s,monitor);
 const char *pins[]={"bootstrap_receipt_digest","daemon_config_digest","transport_digest","daemon_state_digest","helper_digest","pending"};int ok=1;
 for(size_t k=0;k<6;k++){char *value=hf_json_raw(proof->permit,hf_json_field(proof->permit,0,pins[k]));if(!value){ok=0;break;}fputc(',',s);hf_json_write_string(s,pins[k]);fputc(':',s);fputs(value,s);free(value);}fputc('}',s);if(fclose(s))ok=0;if(ok)ok=hf_private_write(proof->receipt_path,body,size,0);free(body);return ok;
}
static void monitor_process(const char *binary,const char *encoded,const char *failure,const char *operation,int report,int gate,const RecoveryProof *proof){
 setsid();int null=open("/dev/null",O_RDWR|O_CLOEXEC);if(null<0)_exit(78);for(int fd=0;fd<3;fd++)if(dup2(null,fd)<0)_exit(78);if(null>2)close(null);int logs[2],start[2];if(pipe2(logs,O_CLOEXEC)||pipe2(start,O_CLOEXEC))_exit(78);pid_t child=fork();
 if(child<0){_exit(78);}if(child==0){close(report);close(gate);close(logs[0]);close(start[1]);char go=0;if(read(start[0],&go,1)!=1||go!='G')_exit(78);close(start[0]);int null=open("/dev/null",O_RDONLY|O_CLOEXEC);if(null>=0){dup2(null,0);close(null);}dup2(logs[1],1);dup2(logs[1],2);close(logs[1]);char *argv[]={(char*)binary,"--component","12.1","--action","supervisor.serve","--request-base64",(char*)encoded,NULL};char *env[]={"PATH=/usr/sbin:/usr/bin:/sbin:/bin","LANG=C.UTF-8",NULL};execve(binary,argv,env);_exit(78);}
 close(logs[1]);close(start[0]);if(write(report,&child,sizeof child)!=(ssize_t)sizeof child)_exit(78);close(report);char go=0;int allowed=read(gate,&go,1)==1&&go=='G';close(gate);if(allowed){ssize_t released=write(start[1],"G",1);if(released!=1)kill(child,SIGTERM);}close(start[1]);
 HfProcessIdentity process={0},monitor_identity={0};(void)hf_process_identity(child,&process);(void)hf_process_identity(getpid(),&monitor_identity);int published=0;char line[4096],code[97]="NATIVE_DAEMON_EXIT_FAILED";size_t used=0;char buffer[1024];ssize_t n;
 while((n=read(logs[0],buffer,sizeof buffer))!=0){if(n<0){if(errno==EINTR)continue;break;}if(!published)published=finalize_receipt(proof,&process,&monitor_identity);for(ssize_t k=0;k<n;k++){char c=buffer[k];if(c=='\n'){line[used]=0;const char *prefix="hyperfide native: ";if(!strncmp(line,prefix,strlen(prefix))){const char *v=line+strlen(prefix);size_t length=strlen(v);int valid=length>0&&length<sizeof code;for(size_t i=0;valid&&i<length;i++)if(!(v[i]>='A'&&v[i]<='Z')&&!(v[i]>='0'&&v[i]<='9')&&v[i]!='_')valid=0;if(valid)memcpy(code,v,length+1);}used=0;}else if(used+1<sizeof line)line[used++]=c;else used=0;}}
 close(logs[0]);int status=0;while(waitpid(child,&status,0)<0&&errno==EINTR){}char *body=NULL;size_t size=0;FILE *s=open_memstream(&body,&size);if(s){fprintf(s,"{\"schema_version\":1,\"kind\":\"FLEET_DAEMON_FAILURE_V1\",\"operation_id\":\"%s\",\"code\":\"%s\",\"exit_code\":%d,\"daemon\":",operation,code,WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status));hf_process_json(s,&process);fputc('}',s);if(!fclose(s))(void)hf_private_write(failure,body,size,0);free(body);}_exit(0);
}

int hf_supervisor_daemon_recover(const char *request,FILE *out){
 const char *error="DAEMON_RECOVERY_INVALID";int result=1,lock=-1,daemon_lock=-1;char *raw=NULL,*manifest_raw=NULL,*old_raw=NULL,*config_raw=NULL,*transport_raw=NULL,*state_raw=NULL,*record=NULL,*receipt=NULL;size_t n=0;
 HfJson *q=calloc(1,sizeof *q),*p=calloc(1,sizeof *p),*m=calloc(1,sizeof *m),*old=calloc(1,sizeof *old),*config=calloc(1,sizeof *config),*state=calloc(1,sizeof *state),*stored=calloc(1,sizeof *stored);
 char manifest[4096],manifest_pin[72],permit_path[4096],permit_pin[72],operation[37],bootstrap[37],helper[4096],helper_pin[72],root[4096],boot_root[4096],daemon_dir[4096],daemon_config[4096],transport[4096],state_path[4096],receipt_path[4096],recovery_root[4096],attempt[4096],submission[4096],failure[4096],binary[4096],binary_pin[72],org[37],run[37],sandbox[37],boot[37],generation[32],credential[37],version[32],expected[72],self[4096];
 HfProcessIdentity previous={0},retained={0},daemon={0},monitor={0},current={0};unsigned long long before=0;
 const char *request_keys[]={"manifest_path","manifest_digest","recovery_path","recovery_digest"};
 if(geteuid()!=0||!q||!p||!m||!old||!config||!state||!stored||!hf_json_parse(q,request)||!hf_json_only(q,0,request_keys,4)||!text(q,0,"manifest_path",manifest,sizeof manifest)||!text(q,0,"manifest_digest",manifest_pin,sizeof manifest_pin)||!text(q,0,"recovery_path",permit_path,sizeof permit_path)||!text(q,0,"recovery_digest",permit_pin,sizeof permit_pin)||!read_file(manifest,manifest_pin,HF_BODY_LIMIT,1,&manifest_raw,&n)||!hf_json_parse(m,manifest_raw)||!read_file(permit_path,permit_pin,HF_BODY_LIMIT,1,&raw,&n)||!hf_json_parse(p,raw))goto done;
 const char *keys[]={"schema_version","kind","operation_id","bootstrap_id","manifest_digest","helper_path","helper_digest","bootstrap_receipt_digest","daemon_config_digest","transport_digest","daemon_state_digest","previous_daemon","pending","credential_id","previous_recovery_operation_id","previous_recovery_receipt_digest"};char kind[80],actual[80];int64_t schema=0;int binding=hf_json_field(m,0,"binding"),template=hf_json_field(m,0,"template");
 if(!hf_json_only(p,0,keys,16)||!hf_json_i64(p,hf_json_field(p,0,"schema_version"),&schema)||schema!=1||!text(p,0,"kind",kind,sizeof kind)||strcmp(kind,"FLEET_NATIVE_DAEMON_RECOVERY_V1")||!text(p,0,"operation_id",operation,sizeof operation)||!hf_uuid_valid(operation)||!text(p,0,"bootstrap_id",bootstrap,sizeof bootstrap)||!hf_uuid_valid(bootstrap)||!text(m,0,"bootstrap_id",actual,sizeof actual)||strcmp(actual,bootstrap)||!text(p,0,"manifest_digest",actual,sizeof actual)||strcmp(actual,manifest_pin)||!text(p,0,"helper_path",helper,sizeof helper)||!text(p,0,"helper_digest",helper_pin,sizeof helper_pin))goto done;
 ssize_t self_n=readlink("/proc/self/exe",self,sizeof self-1);if(self_n<1||self_n>=(ssize_t)sizeof self-1)goto done;self[self_n]=0;
 if(strcmp(helper,self)||!pinned(helper,helper_pin)||!text(m,template,"runner_binary",binary,sizeof binary)||!text(m,template,"runner_binary_digest",binary_pin,sizeof binary_pin)||!strcmp(binary,helper)||!pinned(binary,binary_pin)||!text(m,binding,"organisation_id",org,sizeof org)||!hf_uuid_valid(org)||!text(m,binding,"run_id",run,sizeof run)||!hf_uuid_valid(run)||!text(m,binding,"sandbox_id",sandbox,sizeof sandbox)||!hf_uuid_valid(sandbox)||!text(m,binding,"boot_id",boot,sizeof boot)||!hf_uuid_valid(boot)||!text(m,binding,"boot_generation",generation,sizeof generation)||!text(m,template,"state_root",root,sizeof root)||!join(boot_root,root,sandbox)||!join(boot_root,boot_root,boot)||!join(daemon_dir,boot_root,"daemon")||!join(daemon_config,boot_root,"daemon.json")||!join(transport,boot_root,"transport.json")||!join(state_path,daemon_dir,"daemon-state.json")||!join(recovery_root,boot_root,"daemon-recoveries")||!join(attempt,recovery_root,operation))goto done;
 char derived[4096];if(!join(derived,attempt,"permit.json")||strcmp(derived,permit_path)||!private_dir(recovery_root)||!private_dir(attempt)||!join(receipt_path,attempt,"receipt.json")||!join(submission,attempt,"submitted.json")||!join(failure,attempt,"failure.json"))goto done;
 if(!join(derived,boot_root,"bootstrap-receipt.json")||!text(p,0,"bootstrap_receipt_digest",expected,sizeof expected)||!read_file(derived,expected,HF_BODY_LIMIT,1,&old_raw,&n)||!hf_json_parse(old,old_raw)||!text(old,0,"bootstrap_id",actual,sizeof actual)||strcmp(actual,bootstrap)||!text(old,0,"manifest_digest",actual,sizeof actual)||strcmp(actual,manifest_pin)||!text(old,0,"credential_id",credential,sizeof credential)||!text(p,0,"credential_id",actual,sizeof actual)||strcmp(actual,credential))goto done;
 if(!text(p,0,"daemon_config_digest",expected,sizeof expected)||!read_file(daemon_config,expected,65536,1,&config_raw,&n)||!hf_json_parse(config,config_raw)||!text(config,0,"state_dir",derived,sizeof derived)||strcmp(derived,daemon_dir)||!text(config,0,"transport_config",derived,sizeof derived)||strcmp(derived,transport)||!text(config,0,"organisation_id",actual,sizeof actual)||strcmp(actual,org)||!text(p,0,"transport_digest",expected,sizeof expected)||!read_file(transport,expected,65536,1,&transport_raw,&n))goto done;
 HfTransportConfig transport_config;if(!hf_transport_config(transport,&transport_config)||strcmp(transport_config.credential_id,credential)||!text(m,template,"origin",derived,sizeof derived)||strcmp(derived,transport_config.origin))goto done;
 if(!identity(p,hf_json_field(p,0,"previous_daemon"),&previous)||!hf_process_identity(getpid(),&current)||strcmp(previous.os_boot_id,current.os_boot_id))goto done;
 int prior=hf_json_field(p,0,"previous_recovery_operation_id");if(prior<0)goto done;
 if(p->tokens[prior].end-p->tokens[prior].start==4&&!memcmp(p->text+p->tokens[prior].start,"null",4)){if(!identity(old,hf_json_field(old,0,"daemon"),&retained))goto done;}else{char previous_op[37],prior_root[4096],*prior_raw=NULL;size_t prior_n=0;if(!text(p,0,"previous_recovery_operation_id",previous_op,sizeof previous_op)||!hf_uuid_valid(previous_op)||!join(prior_root,recovery_root,previous_op)||!join(derived,prior_root,"receipt.json")||!text(p,0,"previous_recovery_receipt_digest",expected,sizeof expected)||!read_file(derived,expected,HF_BODY_LIMIT,1,&prior_raw,&prior_n))goto done;int ok=hf_json_parse(old,prior_raw)&&text(old,0,"bootstrap_id",actual,sizeof actual)&&!strcmp(actual,bootstrap)&&identity(old,hf_json_field(old,0,"daemon"),&retained);free(prior_raw);if(!ok)goto done;}
 if(!equal_identity(&previous,&retained))goto done;
 if(!join(derived,daemon_dir,"recovery.lock")){goto done;}lock=open(derived,O_CREAT|O_RDWR|O_NOFOLLOW|O_CLOEXEC,0600);struct stat st;if(lock<0||fstat(lock,&st)||!S_ISREG(st.st_mode)||st.st_uid||st.st_nlink!=1||(st.st_mode&077)||flock(lock,LOCK_EX|LOCK_NB)){error="DAEMON_RECOVERY_BUSY";goto done;}
 if(read_file(receipt_path,NULL,HF_BODY_LIMIT,1,&receipt,&n)){if(!hf_json_parse(stored,receipt)||!text(stored,0,"recovery_digest",actual,sizeof actual)||strcmp(actual,permit_pin)||!identity(stored,hf_json_field(stored,0,"daemon"),&daemon)||!alive(&daemon)){error="DAEMON_RECOVERY_RECEIPT_STALE";goto done;}fwrite(receipt,1,n,out);result=0;goto done;}
 if(read_file(submission,NULL,65536,1,&record,&n)){if(!hf_json_parse(stored,record)||!text(stored,0,"recovery_digest",actual,sizeof actual)||strcmp(actual,permit_pin)||!identity(stored,hf_json_field(stored,0,"daemon"),&daemon)||!identity(stored,hf_json_field(stored,0,"monitor"),&monitor)){error="DAEMON_RECOVERY_SUBMISSION_INVALID";goto done;}}
 else{
  if(alive(&previous)){error="DAEMON_RECOVERY_PREVIOUS_ALIVE";goto done;}
  if(!text(p,0,"daemon_state_digest",expected,sizeof expected)||!read_file(state_path,expected,HF_BODY_LIMIT,1,&state_raw,&n)||!hf_json_parse(state,state_raw)||!text(state,0,"state_version",version,sizeof version)||!number(version,&before)||!text(p,hf_json_field(p,0,"pending"),"expected_state_version",actual,sizeof actual)||strcmp(actual,version)||!pending_matches(state,p,hf_json_field(p,0,"pending"))){error="DAEMON_RECOVERY_STATE_CHANGED";goto done;}
  if(!join(derived,daemon_dir,"daemon.lock")){goto done;}daemon_lock=open(derived,O_RDWR|O_NOFOLLOW|O_CLOEXEC);if(daemon_lock<0||fstat(daemon_lock,&st)||!S_ISREG(st.st_mode)||st.st_uid||st.st_nlink!=1||(st.st_mode&077)||flock(daemon_lock,LOCK_EX|LOCK_NB)){error="DAEMON_RECOVERY_OBSERVER_BUSY";goto done;}
  char *request_json=NULL;size_t request_size=0;FILE *request_stream=open_memstream(&request_json,&request_size);if(!request_stream)goto done;fputs("{\"config_path\":",request_stream);hf_json_write_string(request_stream,daemon_config);fputc('}',request_stream);if(fclose(request_stream)){free(request_json);goto done;}char *encoded=hf_base64url((unsigned char*)request_json,request_size);free(request_json);int report[2],gate[2];if(!encoded||pipe2(report,O_CLOEXEC)||pipe2(gate,O_CLOEXEC)){free(encoded);goto done;}
  pid_t child=fork();if(child<0){free(encoded);goto done;}if(!child){close(lock);close(daemon_lock);close(report[0]);close(gate[1]);RecoveryProof proof={p,permit_pin,bootstrap,credential,manifest_pin,receipt_path,state_path,previous,before};monitor_process(binary,encoded,failure,operation,report[1],gate[0],&proof);_exit(78);}free(encoded);close(report[1]);close(gate[0]);pid_t daemon_pid=0;int ok=read(report[0],&daemon_pid,sizeof daemon_pid)==(ssize_t)sizeof daemon_pid;close(report[0]);
  for(int k=0;ok&&k<20;k++){if(hf_process_identity(child,&monitor)&&hf_process_identity(daemon_pid,&daemon)&&daemon.uid==0&&monitor.uid==0)break;pause_tick();}ok=ok&&daemon.pid==daemon_pid&&monitor.pid==child;
  char *submitted=NULL;size_t submitted_n=0;FILE *s=ok?open_memstream(&submitted,&submitted_n):NULL;if(s){fprintf(s,"{\"schema_version\":1,\"operation_id\":\"%s\",\"recovery_digest\":\"%s\",\"daemon\":",operation,permit_pin);stable_identity(s,&daemon);fputs(",\"monitor\":",s);stable_identity(s,&monitor);fputc('}',s);ok=!fclose(s)&&hf_private_write(submission,submitted,submitted_n,0);}else ok=0;free(submitted);close(daemon_lock);daemon_lock=-1;if(ok)ok=write(gate[1],"G",1)==1;close(gate[1]);if(!ok){error="DAEMON_RECOVERY_SUBMISSION_UNCERTAIN";goto done;}
 }
 if(!text(p,hf_json_field(p,0,"pending"),"expected_state_version",version,sizeof version)||!number(version,&before))goto done;
 for(;;){
  if(read_file(receipt_path,NULL,HF_BODY_LIMIT,1,&receipt,&n)){
   if(!hf_json_parse(stored,receipt)||!text(stored,0,"recovery_digest",actual,sizeof actual)||strcmp(actual,permit_pin)||!alive(&daemon)){error="DAEMON_RECOVERY_RECEIPT_STALE";goto done;}
   fwrite(receipt,1,n,out);result=0;goto done;
  }
  if(!alive(&daemon)||!alive(&monitor)){error="DAEMON_RECOVERY_OBSERVER_EXITED";goto done;}pause_tick();
 }

 done:if(daemon_lock>=0)close(daemon_lock);if(lock>=0)close(lock);free(raw);free(manifest_raw);free(old_raw);free(config_raw);free(transport_raw);free(state_raw);free(record);free(receipt);free(q);free(p);free(m);free(old);free(config);free(state);free(stored);if(result)hf_native_error(out,error);return result;
}
