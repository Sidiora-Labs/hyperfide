#define _GNU_SOURCE
#include "supervisor.h"
#include <openssl/evp.h>
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define FLEET_JSON_LIMIT (4U*1024U*1024U)
static long long now_ns(void){struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))return LLONG_MAX;return (long long)t.tv_sec*1000000000LL+t.tv_nsec;}
static int text(const HfJson *j,int o,const char *k,char *v,size_t n){return hf_json_string(j,hf_json_field(j,o,k),v,n);}
static int equal(const HfJson *j,int o,const char *k,const char *v){char b[4096];return text(j,o,k,b,sizeof b)&&!strcmp(b,v);}
static int sha(const char *s){if(strlen(s)!=71||strncmp(s,"sha256:",7))return 0;for(int n=7;n<71;n++)if(!strchr("0123456789abcdef",s[n]))return 0;return 1;}
static int relative_to(const char *root,const char *target){size_t n=strlen(root);return n>1&&!strncmp(root,target,n)&&target[n]=='/'&&target[n+1]&&!strstr(target,"//")&&!strstr(target,"/../")&&!strstr(target,"/./");}
static int file_hash(int fd,char digest[72],long long deadline){
 EVP_MD_CTX *h=EVP_MD_CTX_new();int ok=h&&EVP_DigestInit_ex(h,EVP_sha256(),NULL)==1;unsigned char bytes[65536],sum[32];unsigned size=0;ssize_t n=0;
 while(ok&&(n=read(fd,bytes,sizeof bytes))>0)if(now_ns()>=deadline||EVP_DigestUpdate(h,bytes,(size_t)n)!=1)ok=0;
 if(ok&&(n<0||EVP_DigestFinal_ex(h,sum,&size)!=1||size!=32))ok=0;
 if(ok){memcpy(digest,"sha256:",7);for(unsigned i=0;i<32;i++)snprintf(digest+7+i*2,3,"%02x",sum[i]);if(lseek(fd,0,SEEK_SET)<0)ok=0;}
 EVP_MD_CTX_free(h);return ok;
}
static int protected_parent(const char *filename,int root_only,uid_t extra){
 if(!filename||filename[0]!='/'||strlen(filename)>4095||strstr(filename,"//"))return -1;
 char *copy=strdup(filename),*last=copy?strrchr(copy,'/'):NULL;if(!last||!last[1]){free(copy);return -1;}*last=0;
 int fd=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC);char *save=NULL;
 for(char *p=fd>=0?strtok_r(copy,"/",&save):NULL;p;p=strtok_r(NULL,"/",&save)){
  if(!strcmp(p,".")||!strcmp(p,"..")){close(fd);fd=-1;break;}int next=openat(fd,p,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);struct stat st;
  if(next<0||fstat(next,&st)||(st.st_uid!=0&&(root_only||st.st_uid!=extra))||(st.st_mode&022)){if(next>=0)close(next);close(fd);fd=-1;break;}close(fd);fd=next;
 }
 free(copy);return fd;
}
static int pinned_file(const char *filename,const char *expected,int executable,long long deadline){
 if(!sha(expected))return -1;int parent=protected_parent(filename,1,0);if(parent<0)return -1;const char *leaf=strrchr(filename,'/')+1;
 int fd=openat(parent,leaf,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);close(parent);struct stat before,after;char digest[72];
 if(fd<0||fstat(fd,&before)||!S_ISREG(before.st_mode)||before.st_uid!=0||(before.st_mode&022)||(executable&&!(before.st_mode&0111))||!file_hash(fd,digest,deadline)||strcmp(digest,expected)||fstat(fd,&after)||before.st_dev!=after.st_dev||before.st_ino!=after.st_ino||before.st_size!=after.st_size||before.st_mtim.tv_sec!=after.st_mtim.tv_sec||before.st_mtim.tv_nsec!=after.st_mtim.tv_nsec){if(fd>=0)close(fd);return -1;}return fd;
}
static void kill_uid_others(uid_t uid){
 if(!uid)return;DIR *d=opendir("/proc");if(!d)return;struct dirent *e;
 while((e=readdir(d))){char *end;long pid=strtol(e->d_name,&end,10);if(*end||pid<=1||pid>INT_MAX||pid==getpid())continue;HfProcessIdentity p,actual;if(hf_process_identity((pid_t)pid,&p)&&p.uid==uid&&p.state!='Z'&&p.state!='X'&&hf_process_matches(&p,&actual))(void)kill(actual.pid,SIGKILL);}closedir(d);
}
static int run_json(int executable,const char *node,const char *module,const char *context,uid_t uid,gid_t gid,const char *cwd,const char *home,const char *tmp,const char *input,size_t input_size,long long deadline,char **output,size_t *output_size){
 signal(SIGPIPE,SIG_IGN);
 int in[2],out[2],err[2];if(input_size>FLEET_JSON_LIMIT||now_ns()>=deadline||pipe2(in,O_CLOEXEC)||pipe2(out,O_CLOEXEC)||pipe2(err,O_CLOEXEC))return 0;
 pid_t parent=getpid(),child=fork();if(child==0){
  setpgid(0,0);if(prctl(PR_SET_PDEATHSIG,SIGKILL)||getppid()!=parent||dup2(in[0],0)<0||dup2(out[1],1)<0||dup2(err[1],2)<0)_exit(125);
  if(chdir(cwd)||clearenv()||setenv("PATH","/usr/local/bin:/usr/bin:/bin",1)||setenv("HOME",home,1)||setenv("TMPDIR",tmp,1)||setenv("LANG","C.UTF-8",1))_exit(125);
  if(uid&&((geteuid()==0?(setgroups(0,NULL)||setgid(gid)||setuid(uid)):(geteuid()!=uid||getegid()!=gid||getgroups(0,NULL)!=0))||prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)))_exit(125);
  if(prctl(PR_SET_PDEATHSIG,SIGKILL)||getppid()!=parent)_exit(125);
  if(executable!=3&&dup3(executable,3,O_CLOEXEC)<0)_exit(125);if(close_range(4,~0U,0))_exit(125);
  char *argv[]={(char*)node,(char*)module,context?"--derive":NULL,(char*)context,NULL};fexecve(3,argv,environ);_exit(127);
 }
 close(in[0]);close(out[1]);close(err[1]);if(child<0){close(in[1]);close(out[0]);close(err[0]);return 0;}setpgid(child,child);
 fcntl(in[1],F_SETFL,O_NONBLOCK);fcntl(out[0],F_SETFL,O_NONBLOCK);fcntl(err[0],F_SETFL,O_NONBLOCK);
 char *bytes=malloc(FLEET_JSON_LIMIT+1);size_t sent=0,used=0,errors=0;int input_open=1,eof[2]={0,0},finished=0,status=0,ok=bytes!=NULL;
 while(ok&&(!finished||!eof[0]||!eof[1])&&now_ns()<deadline){
  struct pollfd p[]={{input_open?in[1]:-1,POLLOUT,0},{eof[0]?-1:out[0],POLLIN,0},{eof[1]?-1:err[0],POLLIN,0}};int n=poll(p,3,10);if(n<0&&errno!=EINTR){ok=0;break;}
  if(input_open&&(p[0].revents&POLLOUT)){ssize_t w=write(in[1],input+sent,input_size-sent);if(w>0)sent+=(size_t)w;else if(w<0&&errno!=EAGAIN&&errno!=EINTR)ok=0;if(sent==input_size){close(in[1]);input_open=0;}}
  for(int k=0;k<2;k++)if(!eof[k]&&(p[k+1].revents&(POLLIN|POLLHUP|POLLERR))){char buffer[8192];ssize_t got;while((got=read(p[k+1].fd,buffer,sizeof buffer))>0){if(k){errors+=(size_t)got;if(errors>1048576)ok=0;}else if(used+(size_t)got>FLEET_JSON_LIMIT)ok=0;else{memcpy(bytes+used,buffer,(size_t)got);used+=(size_t)got;}}if(got==0){close(p[k+1].fd);eof[k]=1;}}
  if(!finished){pid_t seen=waitpid(child,&status,WNOHANG);if(seen==child)finished=1;else if(seen<0&&errno!=EINTR)ok=0;}
 }
 if(!finished){kill(-child,SIGKILL);while(waitpid(child,&status,0)<0&&errno==EINTR){}}
 if(input_open)close(in[1]);if(!eof[0])close(out[0]);if(!eof[1])close(err[0]);if(uid)kill_uid_others(uid);
 ok=ok&&finished&&WIFEXITED(status)&&WEXITSTATUS(status)==0&&sent==input_size&&now_ns()<deadline&&!memchr(bytes,0,used);
 if(!ok){free(bytes);return 0;}bytes[used]=0;*output=bytes;*output_size=used;return 1;
}
static int parse_mode(const char *s,mode_t *out){if(strlen(s)!=4||s[0]!='0')return 0;unsigned value=0;for(int n=1;n<4;n++){if(s[n]<'0'||s[n]>'7')return 0;value=value*8+(unsigned)(s[n]-'0');}*out=(mode_t)value;return 1;}
static int check_config_seals(const HfJson *j,int input,long long deadline){
 if(geteuid()!=0)return 0;int slot=hf_json_field(j,input,"slot"),configs=hf_json_field(j,input,"configurations");char root[4096],home[4096];int64_t uid=0,gid=0;
 if(!text(j,slot,"worker_root",root,sizeof root)||!text(j,slot,"home",home,sizeof home)||!hf_json_i64(j,hf_json_field(j,slot,"uid"),&uid)||uid<1||!hf_json_i64(j,hf_json_field(j,slot,"gid"),&gid)||gid<1||configs<0||j->tokens[configs].type!='[')return 0;
 int entry=configs+1;for(int n=0;n<j->tokens[configs].count;n++){
  if(equal(j,entry,"kind","secret-ref")){
   char name[129],target[4096],seal[4096],expected[4096],reference[512],version[256],mode_text[8];mode_t mode;
   if(!text(j,entry,"name",name,sizeof name)||strchr(name,'/')||!text(j,entry,"target",target,sizeof target)||!relative_to(home,target)||!text(j,entry,"seal_path",seal,sizeof seal)||snprintf(expected,sizeof expected,"%s/.hyperfide-seals/configuration-%s.json",root,name)>=(int)sizeof expected||strcmp(expected,seal)||!text(j,entry,"reference",reference,sizeof reference)||!text(j,entry,"version",version,sizeof version)||!text(j,entry,"mode",mode_text,sizeof mode_text)||!parse_mode(mode_text,&mode))return 0;
   int dir=protected_parent(seal,1,0);if(dir<0)return 0;int fd=openat(dir,strrchr(seal,'/')+1,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);close(dir);struct stat st;
   if(fd<0||fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_uid!=0||st.st_nlink!=1||(st.st_mode&077)||st.st_size<1||st.st_size>16384){if(fd>=0)close(fd);return 0;}
   char body[16385];ssize_t got=read(fd,body,(size_t)st.st_size);close(fd);if(got!=st.st_size)return 0;body[got]=0;HfJson *seal_json=calloc(1,sizeof *seal_json);int ok=seal_json&&hf_json_parse(seal_json,body)&&equal(seal_json,0,"reference",reference)&&equal(seal_json,0,"version",version)&&equal(seal_json,0,"target",target);char expected_hash[72];if(ok)ok=text(seal_json,0,"digest",expected_hash,sizeof expected_hash)&&sha(expected_hash);free(seal_json);if(!ok)return 0;
   dir=protected_parent(target,0,(uid_t)uid);if(dir<0)return 0;fd=openat(dir,strrchr(target,'/')+1,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);close(dir);char actual_hash[72];
   ok=fd>=0&&!fstat(fd,&st)&&S_ISREG(st.st_mode)&&st.st_uid==(uid_t)uid&&st.st_gid==(gid_t)gid&&st.st_nlink==1&&(st.st_mode&0777)==mode&&file_hash(fd,actual_hash,deadline)&&!strcmp(actual_hash,expected_hash);if(fd>=0)close(fd);if(!ok)return 0;
  }
  entry=j->tokens[entry].next;
 }
 return 1;
}
static int normalize_shared(const HfJson *j,int input,const char *environment_root,long long deadline){
 int slot=hf_json_field(j,input,"slot"),configs=hf_json_field(j,input,"configurations");char worker[4096];if(!text(j,slot,"worker_root",worker,sizeof worker)||configs<0||j->tokens[configs].type!='[')return 0;
 int item=configs+1;for(int n=0;n<j->tokens[configs].count;n++){
  int private_config=1;if(!hf_json_bool(j,hf_json_field(j,item,"private"),&private_config))return 0;
  if(!private_config){char target[4096],expected[72];if(!equal(j,item,"kind","config-ref")||!equal(j,item,"mode","0444")||!text(j,item,"target",target,sizeof target)||!relative_to(environment_root,target)||relative_to(worker,target)||!text(j,item,"digest",expected,sizeof expected)||!sha(expected))return 0;
   char *copy=strdup(target+strlen(environment_root)+1),*save=NULL;int fd=open(environment_root,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),ok=copy&&fd>=0;
   for(char *part=ok?strtok_r(copy,"/",&save):NULL;part&&ok;part=strtok_r(NULL,"/",&save)){if(!strcmp(part,".")||!strcmp(part,"..")){ok=0;break;}int last=save&&!*save,next=openat(fd,part,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|(last?0:O_DIRECTORY));struct stat st;
    if(next<0||fstat(next,&st)||(st.st_mode&022)||(!last&&!S_ISDIR(st.st_mode))||(last&&(!S_ISREG(st.st_mode)||st.st_nlink!=1))){if(next>=0)close(next);ok=0;break;}
    char actual[72];if(last&&(!file_hash(next,actual,deadline)||strcmp(actual,expected)))ok=0;
    if(ok&&(fchown(next,0,0)||fchmod(next,last?0444:0711)))ok=0;close(fd);fd=next;
   }if(fd>=0)close(fd);free(copy);if(!ok)return 0;
  }
  item=j->tokens[item].next;
 }
 return 1;
}
static int normalize_tools(const HfJson *j,int input,const HfJson *bootstrap,int slots,const char *environment_root,long long deadline){
 int tools=hf_json_field(j,input,"toolchains");if(tools<0||j->tokens[tools].type!='[')return 0;int item=tools+1;
 for(int n=0;n<j->tokens[tools].count;n++){
  char target[4096],expected[72];if(!text(j,item,"executable",target,sizeof target)||!text(j,item,"digest",expected,sizeof expected)||!sha(expected))return 0;
  if(relative_to(environment_root,target)){
   int candidate=slots+1;for(int k=0;k<bootstrap->tokens[slots].count;k++){char barrier[4096];if(!text(bootstrap,candidate,"worker_root",barrier,sizeof barrier)||!strcmp(barrier,target)||relative_to(barrier,target))return 0;candidate=bootstrap->tokens[candidate].next;}
   char *copy=strdup(target+strlen(environment_root)+1),*save=NULL;int fd=open(environment_root,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),ok=copy&&fd>=0;
   for(char *part=ok?strtok_r(copy,"/",&save):NULL;part&&ok;part=strtok_r(NULL,"/",&save)){
    if(!strcmp(part,".")||!strcmp(part,"..")){ok=0;break;}int last=save&&!*save,next=openat(fd,part,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|(last?0:O_DIRECTORY));struct stat st;
    if(next<0||fstat(next,&st)||(st.st_mode&022)||(!last&&!S_ISDIR(st.st_mode))||(last&&(!S_ISREG(st.st_mode)||st.st_nlink!=1))){if(next>=0)close(next);ok=0;break;}
    char actual[72];if(last&&(!file_hash(next,actual,deadline)||strcmp(actual,expected)))ok=0;
    if(ok&&(fchown(next,0,0)||fchmod(next,last?((st.st_mode&0111)?0555:0444):0711)))ok=0;close(fd);fd=next;
   }
   if(fd>=0)close(fd);free(copy);if(!ok)return 0;
  }
  item=j->tokens[item].next;
 }
 return 1;
}
static int normalize_interfaces(const HfJson *j,int input,const HfJson *bootstrap,int slots,const char *environment_root,long long deadline){
 int data=hf_json_field(j,input,"interfaces");char target[4096],expected[72];
 if(data<0||!text(j,data,"target",target,sizeof target)||!relative_to(environment_root,target)||!text(j,data,"digest",expected,sizeof expected)||!sha(expected))return 0;
 int slot=slots+1;for(int n=0;n<bootstrap->tokens[slots].count;n++){char barrier[4096];if(!text(bootstrap,slot,"worker_root",barrier,sizeof barrier)||!strcmp(barrier,target)||relative_to(barrier,target))return 0;slot=bootstrap->tokens[slot].next;}
 char *copy=strdup(target+strlen(environment_root)+1),*save=NULL;int fd=open(environment_root,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),ok=copy&&fd>=0;
 for(char *part=ok?strtok_r(copy,"/",&save):NULL;part&&ok;part=strtok_r(NULL,"/",&save)){
  if(!strcmp(part,".")||!strcmp(part,"..")){ok=0;break;}int last=save&&!*save,next=openat(fd,part,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|(last?0:O_DIRECTORY));struct stat st;
  if(next<0||fstat(next,&st)||(st.st_mode&022)||(!last&&!S_ISDIR(st.st_mode))||(last&&(!S_ISREG(st.st_mode)||st.st_nlink!=1))){if(next>=0)close(next);ok=0;break;}
  char actual[72];if(last&&(!file_hash(next,actual,deadline)||strcmp(actual,expected)))ok=0;
  if(ok&&(fchown(next,0,0)||fchmod(next,last?0444:0711)))ok=0;close(fd);fd=next;
 }
 if(fd>=0)close(fd);free(copy);return ok;
}
static int root_json_file(const char *filename,size_t maximum,const char *expected,char **bytes,size_t *length){
 int parent=protected_parent(filename,1,0);if(parent<0)return 0;int fd=openat(parent,strrchr(filename,'/')+1,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);close(parent);struct stat st;char actual[72];
 if(fd<0||fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_uid!=0||st.st_nlink!=1||(st.st_mode&022)||st.st_size<1||(uint64_t)st.st_size>maximum){if(fd>=0)close(fd);return 0;}
 if(expected&&(!file_hash(fd,actual,now_ns()+30000000000LL)||strcmp(actual,expected))){close(fd);return 0;}
 char *body=malloc((size_t)st.st_size+1);size_t used=0;if(!body){close(fd);return 0;}
 while(used<(size_t)st.st_size){ssize_t n=read(fd,body+used,(size_t)st.st_size-used);if(n<0&&errno==EINTR)continue;if(n<=0)break;used+=(size_t)n;}close(fd);
 if(used!=(size_t)st.st_size||memchr(body,0,used)){free(body);return 0;}body[used]=0;*bytes=body;*length=used;return 1;
}
static int verify_derive_closure(const HfPreparationStage *stage,long long deadline){
 const char *relative[]={"fleet_readiness_probe.js","fleet_readiness_contract.js","fleet_install_inventory.js","fleet_toolchains.js","fleet_configurations.js","fleet_client.js","../transport/protocol.js","../policy/programme.js","../contracts/fleet/index.mjs"};
 char directory[4096],*context_text=NULL,*plan_text=NULL,plan_path[4096],plan_digest[72];size_t length=0;HfJson *context=calloc(1,sizeof *context),*plan=calloc(1,sizeof *plan);int ok=0;
 if(!context||!plan||!root_json_file(stage->context_path,8*1024*1024,NULL,&context_text,&length)||!hf_json_parse(context,context_text))goto done;
 int staging=hf_json_field(context,0,"staging"),found=-1,item=staging+1;if(staging<0||context->tokens[staging].type!='[')goto done;
 for(int n=0;n<context->tokens[staging].count;n++){if(equal(context,item,"role","fleet.plan")){if(found>=0)goto done;found=item;}item=context->tokens[item].next;}
 if(found<0||!text(context,found,"path",plan_path,sizeof plan_path)||!relative_to(stage->stage_root,plan_path)||!text(context,found,"digest",plan_digest,sizeof plan_digest)||!sha(plan_digest)||!root_json_file(plan_path,FLEET_JSON_LIMIT,plan_digest,&plan_text,&length)||!hf_json_parse(plan,plan_text))goto done;
 int runtime=hf_json_field(plan,0,"runtime_files");if(runtime<0||plan->tokens[runtime].type!='['||plan->tokens[runtime].count>256)goto done;
 strcpy(directory,stage->recipe_path);char *slash=strrchr(directory,'/');if(!slash)goto done;*slash=0;
 for(size_t n=0;n<sizeof relative/sizeof relative[0];n++){
  char source[4096],canonical[4096],expected[72]="";if(snprintf(source,sizeof source,"%s/%s",directory,relative[n])>=(int)sizeof source||!realpath(source,canonical))goto done;
  int match=-1,pin=runtime+1;for(int k=0;k<plan->tokens[runtime].count;k++){if(equal(plan,pin,"path",canonical)){if(match>=0)goto done;match=pin;}pin=plan->tokens[pin].next;}
  if(match<0||!text(plan,match,"digest",expected,sizeof expected)||!sha(expected))goto done;
  int verified=pinned_file(canonical,expected,0,deadline);if(verified<0)goto done;close(verified);
 }
 ok=1;
done:free(context);free(plan);free(context_text);free(plan_text);return ok;
}
static int verifier(const HfJson *j,int at,const HfPreparationStage *stage,char node[4096],char module[4096],long long deadline){
 char nd[72],md[72];if(!text(j,at,"node_path",node,4096)||!text(j,at,"node_digest",nd,sizeof nd)||!text(j,at,"module_path",module,4096)||!text(j,at,"module_digest",md,sizeof md))return -1;
 if(stage){char expected[4096];strcpy(expected,stage->recipe_path);char *leaf=strrchr(expected,'/');if(!leaf||snprintf(leaf+1,sizeof expected-(size_t)(leaf+1-expected),"fleet_readiness_probe.js")>=(int)(sizeof expected-(size_t)(leaf+1-expected))||strcmp(expected,module)||strcmp(node,stage->node_path)||strcmp(nd,stage->node_digest))return -1;}
 int script=pinned_file(module,md,0,deadline);if(script<0)return -1;close(script);return pinned_file(node,nd,1,deadline);
}
int hf_fleet_readiness_finalize(const HfJson *bootstrap,const HfPreparationStage *stage,const unsigned char *prepared,size_t prepared_size,long long deadline,char **readiness_json){
 *readiness_json=NULL;if(geteuid()!=0)return 0;
 int admission=hf_json_field(bootstrap,0,"admission"),v=hf_json_field(bootstrap,0,"readiness_verifier");char node[4096],module[4096],root[4096];
 int binary=verifier(bootstrap,v,stage,node,module,deadline);if(binary<0||!verify_derive_closure(stage,deadline)||!text(bootstrap,admission,"environment_root",root,sizeof root)){if(binary>=0)close(binary);return 0;}
 char *derived=NULL;size_t derived_size=0;if(!run_json(binary,node,module,stage->context_path,0,0,"/","/nonexistent","/tmp",(const char*)prepared,prepared_size,deadline,&derived,&derived_size)){close(binary);return 0;}
 HfJson *d=calloc(1,sizeof *d),*r=calloc(1,sizeof *r);char *body=malloc(prepared_size+1),*output=NULL;size_t output_size=0;FILE *out=NULL;int ok=0;
 if(!d||!r||!body)goto done;memcpy(body,prepared,prepared_size);body[prepared_size]=0;
 if(!hf_json_parse(d,derived)||!hf_json_parse(r,body)||!equal(d,0,"kind","FLEET_READINESS_INPUTS_V1"))goto done;
 int inputs=hf_json_field(d,0,"inputs"),slots=hf_json_field(bootstrap,admission,"slot_bindings"),receipt=hf_json_field(r,0,"receipt");char operation[37],prepared_digest[72],admission_digest[72];
 if(inputs<0||d->tokens[inputs].type!='['||slots<0||bootstrap->tokens[slots].type!='['||d->tokens[inputs].count!=bootstrap->tokens[slots].count||!text(bootstrap,admission,"operation_id",operation,sizeof operation)||!text(r,receipt,"receipt_digest",prepared_digest,sizeof prepared_digest)||!text(bootstrap,admission,"admission_digest",admission_digest,sizeof admission_digest))goto done;
 out=open_memstream(&output,&output_size);if(!out)goto done;fprintf(out,"{\"schema_version\":1,\"kind\":\"FLEET_MANIFEST_V1\",\"operation_id\":\"%s\",\"prepared_receipt_digest\":\"%s\",\"admission_digest\":\"%s\",\"slots\":[",operation,prepared_digest,admission_digest);
 int entry=inputs+1,expected_slot=slots+1;
 for(int index=0;index<d->tokens[inputs].count;index++){
  int derived_verifier=hf_json_field(d,entry,"verifier");const char *verifier_keys[]={"node_path","node_digest","module_path","module_digest"};char verifier_value[4096];
  for(int k=0;k<4;k++)if(!text(bootstrap,v,verifier_keys[k],verifier_value,sizeof verifier_value)||!equal(d,derived_verifier,verifier_keys[k],verifier_value))goto done;
  int input=hf_json_field(d,entry,"readiness_input"),slot=hf_json_field(d,input,"slot");int64_t uid=0,gid=0;char slot_id[37],slot_generation[32],home[4096],temporary[4096],source[4096],expected_input[72],state[72],workspace[72];
  if(!hf_json_i64(d,hf_json_field(d,slot,"uid"),&uid)||uid<1||uid>INT_MAX||!hf_json_i64(d,hf_json_field(d,slot,"gid"),&gid)||gid<1||gid>INT_MAX||!text(d,slot,"worker_slot_id",slot_id,sizeof slot_id)||!equal(bootstrap,expected_slot,"worker_slot_id",slot_id)||!text(d,slot,"slot_generation",slot_generation,sizeof slot_generation)||!equal(bootstrap,expected_slot,"slot_generation",slot_generation)||!text(d,slot,"home",home,sizeof home)||!equal(bootstrap,expected_slot,"home",home)||!text(d,slot,"temporary",temporary,sizeof temporary)||!equal(bootstrap,expected_slot,"temporary",temporary)||!text(d,slot,"source",source,sizeof source)||!equal(bootstrap,expected_slot,"source",source)||!text(d,entry,"input_digest",expected_input,sizeof expected_input)||!sha(expected_input)||!text(d,entry,"source_state_digest",state,sizeof state)||!text(d,entry,"workspace_digest",workspace,sizeof workspace))goto done;
  int configurations=hf_json_field(d,input,"configurations"),configuration=configurations+1;
  if(configurations<0||d->tokens[configurations].type!='[')goto done;
  for(int c=0;c<d->tokens[configurations].count;c++){
   int private_config=1;if(!hf_json_bool(d,hf_json_field(d,configuration,"private"),&private_config))goto done;
   if(!private_config){char target[4096];if(!text(d,configuration,"target",target,sizeof target))goto done;int candidate=slots+1;for(int k=0;k<bootstrap->tokens[slots].count;k++){char barrier[4096];if(!text(bootstrap,candidate,"worker_root",barrier,sizeof barrier)||!strcmp(barrier,target)||relative_to(barrier,target))goto done;candidate=bootstrap->tokens[candidate].next;}}
   configuration=d->tokens[configuration].next;
  }
  int64_t expected_uid=0,expected_gid=0;if(!hf_json_i64(bootstrap,hf_json_field(bootstrap,expected_slot,"uid"),&expected_uid)||expected_uid!=uid||!hf_json_i64(bootstrap,hf_json_field(bootstrap,expected_slot,"gid"),&expected_gid)||expected_gid!=gid||!normalize_tools(d,input,bootstrap,slots,root,deadline)||!normalize_shared(d,input,root,deadline)||!normalize_interfaces(d,input,bootstrap,slots,root,deadline)||!check_config_seals(d,input,deadline))goto done;
  char *request=hf_json_raw(d,input),*measurement=NULL;size_t measurement_size=0;if(!request||!run_json(binary,node,module,NULL,(uid_t)uid,(gid_t)gid,source,home,temporary,request,strlen(request),deadline,&measurement,&measurement_size)){free(request);goto done;}free(request);
  HfJson *m=calloc(1,sizeof *m);char measured[72];int accepted=m&&hf_json_parse(m,measurement)&&equal(m,0,"kind","FLEET_MANIFEST_V1")&&equal(m,0,"status","READY")&&equal(m,0,"input_digest",expected_input)&&equal(m,0,"source_state_digest",state)&&equal(m,0,"workspace_digest",workspace)&&text(m,0,"measurement_digest",measured,sizeof measured)&&sha(measured)&&check_config_seals(d,input,deadline);
  if(!accepted){free(m);free(measurement);goto done;}
  if(index)fputc(',',out);fprintf(out,"{\"worker_slot_id\":\"%s\",\"slot_generation\":\"%s\",\"uid\":%lld,\"gid\":%lld,\"input_digest\":\"%s\",\"measurement_digest\":\"%s\",\"source_state_digest\":\"%s\",\"workspace_digest\":\"%s\",\"status\":\"READY\",\"secret_versions_verified\":true,\"probe_results\":",slot_id,slot_generation,(long long)uid,(long long)gid,expected_input,measured,state,workspace);
  char *probes=hf_json_raw(m,hf_json_field(m,0,"probe_results"));if(!probes){free(m);free(measurement);goto done;}fputs(probes,out);fputc('}',out);free(probes);free(m);free(measurement);entry=d->tokens[entry].next;expected_slot=bootstrap->tokens[expected_slot].next;
 }
 fputs("]}",out);if(fclose(out)){out=NULL;goto done;}out=NULL;*readiness_json=output;output=NULL;ok=1;
done:if(out)fclose(out);close(binary);free(d);free(r);free(body);free(derived);free(output);return ok;
}
int hf_fleet_readiness_seals(const HfJson *job,int result,long long deadline){int ready=hf_json_field(job,result,"readiness");if(!equal(job,ready,"kind","FLEET_MANIFEST_V1"))return 1;return check_config_seals(job,hf_json_field(job,ready,"readiness_input"),deadline);}
int hf_fleet_readiness_measure(const HfJson *job,int result,long long deadline,char source_object[65],char source_tree[65],char source_state[72],char workspace[72]){
 if(geteuid()==0)return 0;int ready=hf_json_field(job,result,"readiness"),v=hf_json_field(job,ready,"verifier"),input=hf_json_field(job,ready,"readiness_input"),binding=hf_json_field(job,result,"binding"),slot=hf_json_field(job,input,"slot");char node[4096],module[4096],home[4096],temporary[4096],source[4096],expected_input[72],expected_state[72],expected_workspace[72];int64_t uid=0,gid=0;
 if(!equal(job,ready,"kind","FLEET_MANIFEST_V1")||!hf_json_i64(job,hf_json_field(job,slot,"uid"),&uid)||uid!=geteuid()||!hf_json_i64(job,hf_json_field(job,slot,"gid"),&gid)||gid!=getegid()||!text(job,slot,"home",home,sizeof home)||!equal(job,binding,"home_path",home)||!text(job,slot,"temporary",temporary,sizeof temporary)||!equal(job,binding,"tmp_path",temporary)||!text(job,slot,"source",source,sizeof source)||!equal(job,binding,"workspace_path",source)||!text(job,ready,"input_digest",expected_input,sizeof expected_input)||!text(job,ready,"source_state_digest",expected_state,sizeof expected_state)||!text(job,ready,"workspace_digest",expected_workspace,sizeof expected_workspace))return 0;
 int binary=verifier(job,v,NULL,node,module,deadline);if(binary<0)return 0;char *request=hf_json_raw(job,input),*output=NULL;size_t size=0;int ok=request&&run_json(binary,node,module,NULL,(uid_t)uid,(gid_t)gid,source,home,temporary,request,strlen(request),deadline,&output,&size);free(request);close(binary);HfJson *m=calloc(1,sizeof *m);
 ok=ok&&m&&hf_json_parse(m,output)&&equal(m,0,"status","READY")&&equal(m,0,"kind","FLEET_MANIFEST_V1")&&equal(m,0,"input_digest",expected_input)&&equal(m,0,"source_state_digest",expected_state)&&equal(m,0,"workspace_digest",expected_workspace)&&text(job,ready,"source_object_id",source_object,65)&&text(job,ready,"source_tree_id",source_tree,65);
 if(ok){strcpy(source_state,expected_state);strcpy(workspace,expected_workspace);}free(m);free(output);return ok;
}
