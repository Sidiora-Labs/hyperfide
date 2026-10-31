#define _GNU_SOURCE
#include "supervisor.h"
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <openssl/pem.h>
#include <pwd.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Only the protected, digest-bound provider recipe supplies paths and actions.
 * Slot allocation and every authority transition reuse the ordinary native/API
 * paths; a PREPARING descriptor never claims that its future workspace exists. */
extern int hf_component_12_1(const char *,const char *,FILE *);
typedef struct {
 char name[65],kind[32],id[37],session[37],profile[32];
 char source[4096],home[4096],temporary[4096],build[4096],dirty[4096];
 uid_t uid;gid_t gid;long long storage;int sensitive,ordinal;char *registry;
} BootstrapSlot;
static int text(const HfJson *j,int o,const char *key,char *out,size_t n){return hf_json_string(j,hf_json_field(j,o,key),out,n);}
static int pin(const char *s){if(strlen(s)!=71||strncmp(s,"sha256:",7))return 0;for(size_t i=7;i<71;i++)if(!strchr("0123456789abcdef",s[i]))return 0;return 1;}
static int absolute(const char *s){size_t n=s?strlen(s):0;return n>1&&n<4000&&s[0]=='/'&&s[n-1]!='/'&&!strstr(s,"//")&&!strstr(s,"/../")&&!strstr(s,"/./")&&(n<2||strcmp(s+n-2,"/."))&&(n<3||strcmp(s+n-3,"/.."));}
static int below(const char *root,const char *s){size_t n=strlen(root);return absolute(root)&&absolute(s)&&!strncmp(root,s,n)&&s[n]=='/';}
static int join(char out[4096],const char *a,const char *b){size_t n=strlen(a),m=strlen(b);if(n+m+2>=4096)return 0;memcpy(out,a,n);out[n]='/';memcpy(out+n+1,b,m+1);return 1;}
static int directory(const char *path,uid_t uid,gid_t gid,mode_t mode){
 if(!absolute(path))return 0;
 char *copy=strdup(path),*save=NULL;if(!copy)return 0;
 int fd=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW),ok=fd>=0;
 for(char *p=strtok_r(copy,"/",&save);ok&&p;p=strtok_r(NULL,"/",&save)){
  if(!strcmp(p,".")||!strcmp(p,"..")){ok=0;break;}int final=!save||!*save;
  if(mkdirat(fd,p,final?mode:0755)&&errno!=EEXIST){ok=0;break;}
  int next=openat(fd,p,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);struct stat st;
  if(next<0||fstat(next,&st)||!S_ISDIR(st.st_mode)||(!final&&(st.st_uid!=0||(st.st_mode&022)))){if(next>=0)close(next);ok=0;break;}
  close(fd);fd=next;
  if(final){if(st.st_uid!=0&&st.st_uid!=uid){ok=0;break;}if(fchown(fd,uid,gid)||fchmod(fd,mode)||fsync(fd)){ok=0;break;}}
 }
 if(fd>=0)close(fd);
 free(copy);return ok;
}
static int file_pin(const char *path,const char *expected){
 if(!absolute(path)||!pin(expected))return 0;
 char *copy=strdup(path),*save=NULL;if(!copy)return 0;int fd=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),ok=fd>=0;
 for(char *part=strtok_r(copy,"/",&save);ok&&part;part=strtok_r(NULL,"/",&save)){
  int final=!save||!*save,next=openat(fd,part,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|(final?O_NONBLOCK:O_DIRECTORY));struct stat st;
  if(next<0||fstat(next,&st)||st.st_uid!=0||(!final&&(!S_ISDIR(st.st_mode)||((st.st_mode&022)&&!(st.st_mode&S_ISVTX))))||(final&&(!S_ISREG(st.st_mode)||st.st_nlink!=1||(st.st_mode&022)||st.st_size<=0||st.st_size>536870912))){if(next>=0)close(next);ok=0;break;}close(fd);fd=next;
 }
 free(copy);EVP_MD_CTX *ctx=ok?EVP_MD_CTX_new():NULL;struct stat before,after;unsigned char block[65536],hash[32];unsigned size=0;char encoded[65];
 ok=ok&&ctx&&fstat(fd,&before)==0&&EVP_DigestInit_ex(ctx,EVP_sha256(),NULL)==1;
 while(ok){ssize_t n=read(fd,block,sizeof block);if(n<0&&errno==EINTR)continue;if(n<0){ok=0;break;}if(!n)break;if(EVP_DigestUpdate(ctx,block,(size_t)n)!=1)ok=0;}
 if(ok)ok=EVP_DigestFinal_ex(ctx,hash,&size)==1&&size==32&&fstat(fd,&after)==0&&before.st_dev==after.st_dev&&before.st_ino==after.st_ino&&before.st_size==after.st_size&&before.st_mode==after.st_mode&&before.st_uid==after.st_uid&&before.st_gid==after.st_gid&&before.st_mtim.tv_sec==after.st_mtim.tv_sec&&before.st_mtim.tv_nsec==after.st_mtim.tv_nsec&&before.st_ctim.tv_sec==after.st_ctim.tv_sec&&before.st_ctim.tv_nsec==after.st_ctim.tv_nsec;
 if(ok){for(unsigned i=0;i<32;i++)snprintf(encoded+i*2,3,"%02x",hash[i]);ok=!strcmp(encoded,expected+7);}EVP_MD_CTX_free(ctx);if(fd>=0)close(fd);return ok;
}

static int account_command(const char *path,char *const argv[]){
 pid_t child=fork();if(child<0)return 0;if(!child){setsid();int null=open("/dev/null",O_RDWR);if(null>=0){dup2(null,0);dup2(null,1);dup2(null,2);if(null>2)close(null);}char *environment[]={"PATH=/usr/sbin:/usr/bin:/sbin:/bin","LANG=C.UTF-8",NULL};execve(path,argv,environment);_exit(78);}
 for(int i=0;i<200;i++){int status=0;pid_t observed=waitpid(child,&status,WNOHANG);if(observed==child)return WIFEXITED(status)&&WEXITSTATUS(status)==0;if(observed<0&&errno!=EINTR)return 0;struct timespec delay={0,50000000};nanosleep(&delay,NULL);}kill(-child,SIGKILL);while(waitpid(child,NULL,0)<0&&errno==EINTR){}return 0;
}
static int ensure_account(const HfJson *m,int template,uid_t uid,gid_t gid){
 char username[64],groupname[64],uid_text[32],gid_text[32];snprintf(username,sizeof username,"hf-slot-%u",uid);snprintf(groupname,sizeof groupname,"hf-slot-%u",gid);snprintf(uid_text,sizeof uid_text,"%u",uid);snprintf(gid_text,sizeof gid_text,"%u",gid);
 struct passwd *user=getpwuid(uid);if(user&&(strcmp(user->pw_name,username)||user->pw_gid!=gid))return -1;struct passwd *named_user=getpwnam(username);if(named_user&&named_user->pw_uid!=uid)return -1;
 struct group *group=getgrgid(gid);if(group&&strcmp(group->gr_name,groupname))return -1;struct group *named_group=getgrnam(groupname);if(named_group&&named_group->gr_gid!=gid)return -1;
 int need_user=user==NULL,need_group=group==NULL;if(!need_user&&!need_group)return 1;
 int tools=hf_json_field(m,template,"account_tools");const char *tool_keys[]={"groupadd","useradd"};if(tools<0||!hf_json_only(m,tools,tool_keys,2))return 0;
 const char *names[]={"groupadd","useradd"},*fixed[]={"/usr/sbin/groupadd","/usr/sbin/useradd"};for(size_t k=0;k<2;k++){int tool=hf_json_field(m,tools,names[k]);const char *keys[]={"path","digest"};char path[4096],hash[72];if(!hf_json_only(m,tool,keys,2)||!text(m,tool,"path",path,sizeof path)||strcmp(path,fixed[k])||!text(m,tool,"digest",hash,sizeof hash)||!file_pin(path,hash)||access(path,X_OK))return 0;}
 if(need_group){char *argv[]={"/usr/sbin/groupadd","--gid",gid_text,"--",groupname,NULL};if(!account_command(argv[0],argv))return 0;}
 if(need_user){char *argv[]={"/usr/sbin/useradd","--uid",uid_text,"--gid",gid_text,"--no-create-home","--no-user-group","--no-log-init","--home-dir","/nonexistent","--shell","/usr/sbin/nologin","--",username,NULL};if(!account_command(argv[0],argv))return 0;}
 user=getpwuid(uid);group=getgrgid(gid);return user&&group&&!strcmp(user->pw_name,username)&&user->pw_gid==gid&&!strcmp(group->gr_name,groupname)?1:0;
}
static int key_public(const char *path,char out[44]){
 char *raw=NULL;size_t n=0;if(!hf_private_read(path,16384,&raw,&n))return 0;BIO *bio=BIO_new_mem_buf(raw,(int)n);EVP_PKEY *key=bio?PEM_read_bio_PrivateKey(bio,NULL,NULL,NULL):NULL;unsigned char public_key[32];size_t length=32;
 int ok=key&&EVP_PKEY_is_a(key,"ED25519")&&EVP_PKEY_get_raw_public_key(key,public_key,&length)&&length==32;char *encoded=ok?hf_base64url(public_key,32):NULL;if(encoded&&strlen(encoded)==43)memcpy(out,encoded,44);else ok=0;
 free(encoded);EVP_PKEY_free(key);BIO_free(bio);OPENSSL_cleanse(raw,n);free(raw);return ok;
}
static void operation(const char *bootstrap,const char *kind,char out[37]){char *s=NULL,hash[65];if(asprintf(&s,"%s:%s",bootstrap,kind)<0){out[0]=0;return;}if(!hf_sha256_bytes(s,strlen(s),hash)){free(s);out[0]=0;return;}free(s);snprintf(out,37,"%.8s-%.4s-8%.3s-a%.3s-%.12s",hash,hash+8,hash+13,hash+17,hash+20);}
static char *native(const char *action,const char *request){char *result=NULL;size_t n=0;FILE *s=open_memstream(&result,&n);if(!s)return NULL;int ok=hf_component_12_1(action,request,s)==0;if(fclose(s))ok=0;if(!ok){free(result);return NULL;}return result;}
static char *invoke(const char *config,const char *run,const char *bootstrap,const char *component,const char *action,const char *input){
 char op[37],*payload=NULL;operation(bootstrap,action,op);if(!*op||asprintf(&payload,"{\"run_id\":\"%s\",\"component\":\"%s\",\"action\":\"%s\",\"input\":%s,\"expected_version\":null,\"authority\":null}",run,component,action,input)<0)return NULL;
 HfHttpResponse response={0};HfJson *j=malloc(sizeof *j);int ok=0,accepted=0;
 if(j&&hf_supervisor_call(config,0,payload,op,op,op,NULL,NULL,NULL,&response)&&response.status>=200&&response.status<300&&response.body&&hf_json_parse(j,response.body)&&hf_json_bool(j,hf_json_field(j,0,"ok"),&accepted)&&accepted)ok=1;
 char *answer=ok?hf_json_raw(j,hf_json_field(j,0,"result")):NULL;free(j);free(payload);hf_http_response_free(&response);return answer;
}
static char *transport_json(const char *origin,const char *ca,const char *key,const char *grant,const char *run){char *raw=NULL;size_t n=0;FILE *s=open_memstream(&raw,&n);if(!s)return NULL;fputs("{\"origin\":",s);hf_json_write_string(s,origin);fputs(",\"ca_file\":",s);hf_json_write_string(s,ca);fputs(",\"key_path\":",s);hf_json_write_string(s,key);fputs(",\"grant_path\":",s);hf_json_write_string(s,grant);fprintf(s,",\"run_id\":\"%s\",\"timeout_ms\":10000}",run);if(fclose(s)){free(raw);return NULL;}return raw;}
static int enrolled(const char *config,const char *key,const char *run,const char *sandbox,const char *boot,const char *generation,char credential[37]){
 HfTransportConfig t;char path[4096],*raw=NULL;size_t n=0;if(!hf_transport_config(config,&t)||!*t.credential_id||*t.grant_path||strlen(key)+17>=sizeof path)return 0;strcpy(path,key);strcat(path,".enrollment.json");if(!hf_private_read(path,65536,&raw,&n))return 0;
 HfJson *j=malloc(sizeof *j);int ok=0,accepted=0;char value[64];if(j&&hf_json_parse(j,raw)&&hf_json_bool(j,hf_json_field(j,0,"ok"),&accepted)&&accepted){int r=hf_json_field(j,0,"result");ok=text(j,r,"credential_id",credential,37)&&!strcmp(credential,t.credential_id)&&text(j,r,"role",value,sizeof value)&&!strcmp(value,"RUNNER")&&text(j,r,"run_id",value,sizeof value)&&!strcmp(value,run)&&text(j,r,"sandbox_id",value,sizeof value)&&!strcmp(value,sandbox)&&text(j,r,"boot_id",value,sizeof value)&&!strcmp(value,boot)&&text(j,r,"boot_generation",value,sizeof value)&&!strcmp(value,generation);}
 free(j);free(raw);return ok;
}
static int private_parent(const char *environment,const char *workspace,uid_t uid,gid_t gid){char parent[4096];if(!below(workspace,environment))return 0;strcpy(parent,environment);char *slash=strrchr(parent,'/');if(!slash)return 0;*slash=0;if(!below(workspace,parent))return 0;struct stat st;if(!lstat(environment,&st)||errno!=ENOENT)return 0;if(!lstat(parent,&st))return S_ISDIR(st.st_mode)&&!S_ISLNK(st.st_mode)&&st.st_uid==uid&&st.st_gid==gid&&(st.st_mode&0777)==0700;if(errno!=ENOENT)return 0;return directory(parent,uid,gid,0700);}
static int activation(const HfJson *request,const HfJson *manifest,int binding,int template,const char *state,const char *slot_root,const char *self,const char *manifest_digest,const char *bootstrap,const char *boot,const char *preparation,FILE *out){
 char path[4096],expected[72],exact[4096],*raw=NULL,*inventory=NULL,*receipt=NULL,*released=NULL,*binding_raw=NULL;size_t n=0,inventory_n=0;HfJson *permit=malloc(sizeof *permit),*reply=malloc(sizeof *reply);const char *error="ACTIVATION_PERMIT_REFUSED";int result=1;
 if(!permit||!reply||!hf_json_get(request,"activation_path",path,sizeof path)||!hf_json_get(request,"activation_digest",expected,sizeof expected)||!pin(expected)||!join(exact,state,"activation-permit.json")||strcmp(path,exact)||!hf_protected_read(path,65536,&raw,&n))goto done;
 struct stat st;char hash[65];if(lstat(path,&st)||st.st_uid||(st.st_mode&077)||!hf_sha256_bytes(raw,n,hash)||strcmp(hash,expected+7)||!hf_json_parse(permit,raw))goto done;
 const char *keys[]={"schema_version","kind","bootstrap_id","manifest_digest","helper_path","helper_digest","preparation_operation_id","preparation_receipt_digest","released_allocation_id","preparation_slot_id","worker_slot_id"};
 int64_t schema=0;char value[4096],helper[4096],helper_digest[72],operation_id[37],receipt_digest[72],allocation[37],preparer[37],worker[37];
 if(!hf_json_only(permit,0,keys,11)||!hf_json_i64(permit,hf_json_field(permit,0,"schema_version"),&schema)||schema!=1||!hf_json_get(permit,"kind",value,sizeof value)||strcmp(value,"FLEET_NATIVE_ACTIVATION_V1")||!hf_json_get(permit,"bootstrap_id",value,sizeof value)||strcmp(value,bootstrap)||!hf_json_get(permit,"manifest_digest",value,sizeof value)||strcmp(value,manifest_digest)||!hf_json_get(permit,"helper_path",helper,sizeof helper)||strcmp(helper,self)||!hf_json_get(permit,"helper_digest",helper_digest,sizeof helper_digest)||!file_pin(helper,helper_digest)||!hf_json_get(permit,"preparation_operation_id",operation_id,37)||!hf_uuid_valid(operation_id)||!hf_json_get(permit,"preparation_receipt_digest",receipt_digest,sizeof receipt_digest)||!pin(receipt_digest)||!hf_json_get(permit,"released_allocation_id",allocation,37)||!hf_uuid_valid(allocation)||!hf_json_get(permit,"preparation_slot_id",preparer,37)||!hf_uuid_valid(preparer)||!hf_json_get(permit,"worker_slot_id",worker,37)||!hf_uuid_valid(worker)||!strcmp(preparer,worker))goto done;
 int slots=hf_json_field(manifest,template,"slots"),count=0,found_preparer=0,found_worker=0;int64_t uid=0,gid=0;
 if(slots<0||manifest->tokens[slots].type!='[')goto done;
 for(int k=slots+1;k<manifest->tokens[slots].next;k=manifest->tokens[k].next){char kind[32],id[37];if(++count>2||!text(manifest,k,"kind",kind,sizeof kind)||!text(manifest,k,"slot_id",id,sizeof id))goto done;if(!strcmp(kind,"PREPARATION")&&!strcmp(id,preparer))found_preparer++;else if(!strcmp(kind,"AGENT")&&!strcmp(id,worker)){found_worker++;if(!hf_json_i64(manifest,hf_json_field(manifest,k,"uid"),&uid)||uid<1||uid>2147483647||!hf_json_i64(manifest,hf_json_field(manifest,k,"gid"),&gid)||gid<1||gid>2147483647)goto done;}else goto done;}
 if(count!=2||found_preparer!=1||found_worker!=1)goto done;
 char activation_receipt[4096];if(!join(activation_receipt,state,"activation-receipt.json"))goto done;
 char *cached=NULL;size_t cached_n=0;if(hf_private_read(activation_receipt,HF_BODY_LIMIT,&cached,&cached_n)){int valid=hf_json_parse(reply,cached)&&hf_json_get(reply,"activation_digest",value,sizeof value)&&!strcmp(value,expected)&&hf_slot_credentials_allowed(slot_root,worker,boot,(uid_t)uid,(gid_t)gid);if(valid){fputs(cached,out);result=0;}else error="ACTIVATION_RECEIPT_RECONCILIATION_REQUIRED";free(cached);goto done;}
 char bootstrap_receipt[4096],*before=NULL;size_t before_n=0;if(!join(bootstrap_receipt,state,"bootstrap-receipt.json")||!hf_private_read(bootstrap_receipt,HF_BODY_LIMIT,&before,&before_n)||!hf_json_parse(reply,before)||!hf_json_get(reply,"manifest_digest",value,sizeof value)||strcmp(value,manifest_digest)){free(before);error="ACTIVATION_BOOTSTRAP_RECEIPT_REQUIRED";goto done;}free(before);
 char *release_request=NULL;size_t release_n=0;FILE *s=open_memstream(&release_request,&release_n);if(!s)goto done;fputs("{\"root\":",s);hf_json_write_string(s,slot_root);fprintf(s,",\"slot_id\":\"%s\"}",preparer);if(fclose(s)){free(release_request);goto done;}released=native("supervisor.slot.release",release_request);free(release_request);int yes=0;if(!released||!hf_json_parse(reply,released)||!hf_json_bool(reply,hf_json_field(reply,0,"released"),&yes)||!yes){error="ACTIVATION_PREPARER_RELEASE_REFUSED";goto done;}
 if(!hf_slot_promote_credentials(slot_root,preparer,worker,boot,preparation,(uid_t)uid,(gid_t)gid)||!hf_slot_inventory(slot_root,boot,preparation,&inventory,&inventory_n)||!hf_slot_credentials_allowed(slot_root,worker,boot,(uid_t)uid,(gid_t)gid)){error="ACTIVATION_EXCLUSIVE_VM_BOUNDARY_REFUSED";goto done;}
 binding_raw=hf_json_raw(manifest,binding);size_t receipt_n=0;s=open_memstream(&receipt,&receipt_n);if(!s)goto done;fprintf(s,"{\"schema_version\":1,\"kind\":\"FLEET_NATIVE_ACTIVATION_RECEIPT_V1\",\"state\":\"ACTIVATED\",\"bootstrap_id\":\"%s\",\"binding\":%s,\"manifest_digest\":\"%s\",\"activation_digest\":\"%s\",\"helper_path\":",bootstrap,binding_raw,manifest_digest,expected);hf_json_write_string(s,helper);fprintf(s,",\"helper_digest\":\"%s\",\"preparation_operation_id\":\"%s\",\"preparation_receipt_digest\":\"%s\",\"released_allocation_id\":\"%s\",\"preparation_slot_id\":\"%s\",\"worker_slot_id\":\"%s\",\"slot_generation\":\"1\",\"uid\":%lld,\"gid\":%lld,\"isolation_profile\":\"vm_dedicated\",\"credential_sensitive\":true,\"vm_level_isolation\":true,\"inventory\":%s}",helper_digest,operation_id,receipt_digest,allocation,preparer,worker,(long long)uid,(long long)gid,inventory);if(fclose(s)||!hf_private_write(activation_receipt,receipt,receipt_n,0)){error="ACTIVATION_RECEIPT_RECONCILIATION_REQUIRED";goto done;}fputs(receipt,out);result=0;
 done:if(result)hf_native_error(out,error);free(permit);free(reply);free(raw);free(inventory);free(receipt);free(released);free(binding_raw);return result;
}
static int bootstrap(const char *request,FILE *out,int stage){
 HfJson *q=malloc(sizeof *q),*m=malloc(sizeof *m),*parsed=malloc(sizeof *parsed);char manifest[4096],expected[72],*raw=NULL;size_t raw_n=0;int lock=-1,result=1;BootstrapSlot slots[65]={0};size_t count=0;char *inventory=NULL,*receipt=NULL,*recipes=NULL,*binding_raw=NULL;const char *error="BOOTSTRAP_MANIFEST_REFUSED";
 const char *request_keys[]={"manifest_path","manifest_digest","activation_path","activation_digest"};
 if(geteuid()!=0||!q||!m||!parsed||!hf_json_parse(q,request)||!hf_json_only(q,0,request_keys,stage==2?4:2)||!hf_json_get(q,"manifest_path",manifest,sizeof manifest)||!hf_json_get(q,"manifest_digest",expected,sizeof expected)||!pin(expected)||!hf_protected_read(manifest,HF_BODY_LIMIT,&raw,&raw_n))goto done;
 struct stat manifest_stat;if(lstat(manifest,&manifest_stat)||manifest_stat.st_uid||(manifest_stat.st_mode&077))goto done;
 char actual[65];if(!hf_sha256_bytes(raw,raw_n,actual)||strcmp(actual,expected+7)||!hf_json_parse(m,raw))goto done;
 const char *top_keys[]={"schema_version","kind","bootstrap_id","binding","enrollment","template"};int64_t schema=0;char kind[64],bootstrap[37];
 if(!hf_json_only(m,0,top_keys,6)||!hf_json_i64(m,hf_json_field(m,0,"schema_version"),&schema)||schema!=1||!hf_json_get(m,"kind",kind,sizeof kind)||strcmp(kind,"FLEET_NATIVE_BOOTSTRAP_V1")||!hf_json_get(m,"bootstrap_id",bootstrap,sizeof bootstrap)||!hf_uuid_valid(bootstrap))goto done;
 error="BOOTSTRAP_BINDING_REFUSED";
 int b=hf_json_field(m,0,"binding"),e=hf_json_field(m,0,"enrollment"),t=hf_json_field(m,0,"template");
 const char *binding_keys[]={"organisation_id","run_id","provisioning_intent_id","sandbox_id","native_sandbox_id","boot_id","boot_generation","configuration_digest","profile_id","preparation_digest"};
 char org[37],run[37],intent[37],sandbox[37],boot[37],generation[32],preparation[72],value[4096];
 if(!hf_json_only(m,b,binding_keys,10)||!text(m,b,"organisation_id",org,37)||!hf_uuid_valid(org)||!text(m,b,"run_id",run,37)||!hf_uuid_valid(run)||!text(m,b,"provisioning_intent_id",intent,37)||strcmp(intent,bootstrap)||!text(m,b,"sandbox_id",sandbox,37)||!hf_uuid_valid(sandbox)||!text(m,b,"boot_id",boot,37)||!hf_uuid_valid(boot)||!text(m,b,"boot_generation",generation,sizeof generation)||!generation[0]||strspn(generation,"0123456789")!=strlen(generation)||generation[0]=='0'||!text(m,b,"preparation_digest",preparation,sizeof preparation)||!pin(preparation)||!text(m,b,"configuration_digest",value,sizeof value)||!pin(value)||!text(m,b,"profile_id",value,sizeof value)||!hf_uuid_valid(value)||!text(m,b,"native_sandbox_id",value,sizeof value)||!value[0])goto done;
 error="BOOTSTRAP_TEMPLATE_REFUSED";
 const char *template_keys[]={"origin","ca_file","state_root","slot_root","workspace_root","environment_root","runner_binary","runner_binary_digest","repository_id","files","preparation_recipes","slots","account_tools"};
 char origin[512],ca[4096],state_base[4096],slot_base[4096],workspace[4096],environment[4096],binary[4096],binary_digest[72],repository[37],state[4096],slot_root[4096],temp[4096];
 if(!hf_json_only(m,t,template_keys,hf_json_field(m,t,"account_tools")>=0?13:12)||!text(m,t,"origin",origin,sizeof origin)||strncmp(origin,"https://",8)||!text(m,t,"ca_file",ca,sizeof ca)||!text(m,t,"state_root",state_base,sizeof state_base)||!text(m,t,"slot_root",slot_base,sizeof slot_base)||!text(m,t,"workspace_root",workspace,sizeof workspace)||!text(m,t,"environment_root",environment,sizeof environment)||!text(m,t,"runner_binary",binary,sizeof binary)||!text(m,t,"runner_binary_digest",binary_digest,sizeof binary_digest)||!text(m,t,"repository_id",repository,37)||!hf_uuid_valid(repository)||!absolute(ca)||!absolute(state_base)||!absolute(slot_base)||!absolute(workspace)||!below(workspace,environment)||!file_pin(binary,binary_digest))goto done;
 if(!strcmp(state_base,slot_base)||below(state_base,slot_base)||below(slot_base,state_base)||below(state_base,workspace)||below(slot_base,workspace)||!strcmp(workspace,state_base)||!strcmp(workspace,slot_base))goto done;
 char self[4096];ssize_t self_n=readlink("/proc/self/exe",self,sizeof self-1);if(self_n<=0||self_n>=(ssize_t)sizeof self-1)goto done;self[self_n]=0;if(stage!=2&&strcmp(self,binary))goto done;
 error="BOOTSTRAP_RUNTIME_FILES_REFUSED";
 int files=hf_json_field(m,t,"files"),file_count=0;if(files<0||m->tokens[files].type!='[')goto done;
 for(int f=files+1;f<m->tokens[files].next;f=m->tokens[f].next){const char *keys[]={"path","digest"};char path[4096],hash[72];if(++file_count>256||!hf_json_only(m,f,keys,2)||!text(m,f,"path",path,sizeof path)||!text(m,f,"digest",hash,sizeof hash)||!file_pin(path,hash))goto done;}
 error="BOOTSTRAP_RECIPE_FILES_REFUSED";
 int recipe_map=hf_json_field(m,t,"preparation_recipes");if(recipe_map<0||m->tokens[recipe_map].type!='{')goto done;
 for(int k=recipe_map+1;k<m->tokens[recipe_map].next;){int r=k+1;const char *paths[]={"node_path","recipe_path","native_path"},*digests[]={"node_digest","recipe_digest","native_digest"};for(size_t x=0;x<3;x++){char path[4096],hash[72];if(!text(m,r,paths[x],path,sizeof path)||!text(m,r,digests[x],hash,sizeof hash)||!file_pin(path,hash))goto done;}int verifier=hf_json_field(m,r,"readiness_verifier"),closure=hf_json_field(m,verifier,"module_closure");if(closure<0||m->tokens[closure].type!='[')goto done;for(int c=closure+1;c<m->tokens[closure].next;c=m->tokens[c].next){char path[4096],hash[72];if(!text(m,c,"path",path,sizeof path)||!text(m,c,"digest",hash,sizeof hash)||!file_pin(path,hash))goto done;}k=m->tokens[r].next;}
 error="BOOTSTRAP_STATE_ROOT_REFUSED";
 if(!file_count||!join(temp,state_base,sandbox)||!join(state,temp,boot)||!directory(state,0,0,0700)||!join(temp,slot_base,sandbox)||!join(slot_root,temp,boot)||!directory(slot_root,0,0,0711))goto done;
 char lock_path[4096],bound_path[4096],receipt_path[4096],key[4096],config[4096],daemon_dir[4096],daemon_config[4096];
 if(!join(lock_path,state,"bootstrap.lock")||!join(bound_path,state,"manifest-digest")||!join(receipt_path,state,"bootstrap-receipt.json")||!join(key,state,"runner.pem")||!join(config,state,"transport.json")||!join(daemon_dir,state,"daemon")||!join(daemon_config,state,"daemon.json"))goto done;
 lock=open(lock_path,O_CREAT|O_RDWR|O_NOFOLLOW|O_CLOEXEC,0600);struct stat st;if(lock<0||fstat(lock,&st)||!S_ISREG(st.st_mode)||st.st_uid||st.st_nlink!=1||(st.st_mode&077)||flock(lock,LOCK_EX|LOCK_NB))goto done;
 char *bound=NULL;size_t bound_n=0;if(hf_private_read(bound_path,128,&bound,&bound_n)){int same=bound_n==strlen(expected)&&!memcmp(bound,expected,bound_n);free(bound);if(!same)goto done;}else if(errno!=ENOENT||!hf_private_write(bound_path,expected,strlen(expected),0))goto done;
 error="BOOTSTRAP_ENROLLMENT_DESCRIPTOR_REFUSED";
 char grant[4096],grant_id[37],enroll_op[37],enroll_key[37];const char *enrollment_keys[]={"grant_id","secret_file","operation_id","idempotency_key","allowed_actions"};
 if(!hf_json_only(m,e,enrollment_keys,5)||!text(m,e,"grant_id",grant_id,37)||!hf_uuid_valid(grant_id)||!text(m,e,"secret_file",grant,sizeof grant)||!absolute(grant)||!text(m,e,"operation_id",enroll_op,37)||!hf_uuid_valid(enroll_op)||!text(m,e,"idempotency_key",enroll_key,37)||!hf_uuid_valid(enroll_key))goto done;
 int granted=hf_json_field(m,e,"allowed_actions"),granted_count=0;if(granted<0||m->tokens[granted].type!='[')goto done;for(int a=granted+1;a<m->tokens[granted].next;a=m->tokens[a].next){if(++granted_count>256||!hf_json_string(m,a,value,sizeof value)||!value[0])goto done;}if(!granted_count)goto done;
 char exact_grant[4096];if(!join(exact_grant,state,"enrollment-grant.json")||strcmp(grant,exact_grant))goto done;
 if(stage==1){fprintf(out,"{\"schema_version\":1,\"kind\":\"FLEET_NATIVE_BOOTSTRAP_STAGE_V1\",\"bootstrap_id\":\"%s\",\"manifest_digest\":\"%s\",\"secret_parent_mode\":\"0700\",\"secret_file\":",bootstrap,expected);hf_json_write_string(out,grant);fputs("}",out);result=0;goto done;}
 if(stage==2){result=activation(q,m,b,t,state,slot_root,self,expected,bootstrap,boot,preparation,out);if(result)error=NULL;goto done;}
 char *cached=NULL;size_t cached_n=0;
 if(hf_private_read(receipt_path,HF_BODY_LIMIT,&cached,&cached_n)){
  int64_t pid=0,pgid=0;char hash[72],start[32],os_boot[37];HfProcessIdentity observed={0};int valid=hf_json_parse(parsed,cached)&&hf_json_get(parsed,"manifest_digest",hash,sizeof hash)&&!strcmp(hash,expected);int d=valid?hf_json_field(parsed,0,"daemon"):-1;
  valid=valid&&hf_json_i64(parsed,hf_json_field(parsed,d,"pid"),&pid)&&pid>0&&pid<=2147483647&&hf_json_i64(parsed,hf_json_field(parsed,d,"pgid"),&pgid)&&text(parsed,d,"start_time",start,sizeof start)&&text(parsed,d,"os_boot_id",os_boot,sizeof os_boot)&&hf_process_identity((pid_t)pid,&observed)&&observed.uid==0&&observed.pgid==pgid&&observed.start_time==strtoull(start,NULL,10)&&!strcmp(observed.os_boot_id,os_boot)&&observed.state!='Z';
  if(valid){fputs(cached,out);result=0;}else error="BOOTSTRAP_SUPERVISOR_RECONCILIATION_REQUIRED";free(cached);goto done;
 }
 char public_key[44],credential[37];if(!key_public(key,public_key)&&!hf_transport_keygen(key,public_key)){error="BOOTSTRAP_KEY_UNAVAILABLE";goto done;}
 if(!enrolled(config,key,run,sandbox,boot,generation,credential)){
  char *secret=NULL;size_t secret_n=0;char found[37];if(!hf_private_read(grant,1024,&secret,&secret_n)||!hf_json_parse(parsed,secret)||!hf_json_get(parsed,"grant_id",found,37)||strcmp(found,grant_id)){if(secret){OPENSSL_cleanse(secret,secret_n);free(secret);}error="BOOTSTRAP_GRANT_UNAVAILABLE";goto done;}OPENSSL_cleanse(secret,secret_n);free(secret);
  char *transport=transport_json(origin,ca,key,grant,run);if(!transport||!hf_private_write(config,transport,strlen(transport),1)){free(transport);goto done;}free(transport);
  char *payload=NULL,*request_raw=NULL;size_t n=0;FILE *s=open_memstream(&request_raw,&n);if(!s)goto done;
  if(asprintf(&payload,"{\"run_id\":\"%s\",\"provisioning_intent_id\":\"%s\",\"sandbox_id\":\"%s\",\"boot_generation\":\"%s\",\"boot_id\":\"%s\",\"public_key_b64\":\"%s\"}",run,intent,sandbox,generation,boot,public_key)<0){fclose(s);free(request_raw);goto done;}
  fputs("{\"config_path\":",s);hf_json_write_string(s,config);fputs(",\"payload_json\":",s);hf_json_write_string(s,payload);fprintf(s,",\"operation_id\":\"%s\",\"idempotency_key\":\"%s\",\"correlation_id\":\"%s\"}",enroll_op,enroll_key,enroll_op);free(payload);if(fclose(s)){free(request_raw);goto done;}char *answer=native("supervisor.enroll",request_raw);free(request_raw);free(answer);
  if(!enrolled(config,key,run,sandbox,boot,generation,credential)){error="BOOTSTRAP_ENROLLMENT_UNCONFIRMED";goto done;}
 }
 char *identity=invoke(config,run,bootstrap,"14.1","identity.describe","{}");
 if(!identity||!hf_json_parse(parsed,identity)){free(identity);error="BOOTSTRAP_IDENTITY_SCOPE_UNCONFIRMED";goto done;}
 int principal=hf_json_field(parsed,0,"principal"),actual_actions=hf_json_field(parsed,principal,"allowed_actions"),actual_count=0;
 if(actual_actions<0||parsed->tokens[actual_actions].type!='['){free(identity);goto done;}
 for(int a=actual_actions+1;a<parsed->tokens[actual_actions].next;a=parsed->tokens[a].next){char action[129];int found=0;if(!hf_json_string(parsed,a,action,sizeof action)){free(identity);goto done;}actual_count++;for(int expected_action=granted+1;expected_action<m->tokens[granted].next;expected_action=m->tokens[expected_action].next){if(hf_json_string(m,expected_action,value,sizeof value)&&!strcmp(action,value))found++;}if(found!=1){free(identity);error="BOOTSTRAP_IDENTITY_SCOPE_UNCONFIRMED";goto done;}}
 free(identity);if(actual_count!=granted_count){error="BOOTSTRAP_IDENTITY_SCOPE_UNCONFIRMED";goto done;}
 if(unlink(grant)&&errno!=ENOENT){error="BOOTSTRAP_GRANT_CLEANUP_REQUIRED";goto done;}
 int list=hf_json_field(m,t,"slots"),preparer=-1;if(list<0||m->tokens[list].type!='[')goto done;
 recipes=hf_json_raw(m,hf_json_field(m,t,"preparation_recipes"));if(!recipes||m->tokens[hf_json_field(m,t,"preparation_recipes")].type!='{')goto done;
 for(int i=list+1;i<m->tokens[list].next;i=m->tokens[i].next){
  if(count>=65)goto done;
  BootstrapSlot *slot=&slots[count];char *allocation=NULL;size_t allocation_n=0;int64_t uid=0,gid=0,storage=0,ordinal=0;
  const char *base_keys[]={"name","kind","slot_id","session_id","uid","gid","isolation_profile","credential_sensitive","storage_bytes"};
  if(!text(m,i,"name",slot->name,sizeof slot->name)||!slot->name[0]||strspn(slot->name,"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")!=strlen(slot->name)||!text(m,i,"kind",slot->kind,sizeof slot->kind)||!text(m,i,"slot_id",slot->id,37)||!hf_uuid_valid(slot->id)||!text(m,i,"session_id",slot->session,37)||!hf_uuid_valid(slot->session)||!text(m,i,"isolation_profile",slot->profile,sizeof slot->profile)||!hf_json_i64(m,hf_json_field(m,i,"uid"),&uid)||!hf_json_i64(m,hf_json_field(m,i,"gid"),&gid)||uid<=0||uid>2147483647||gid<=0||gid>2147483647||!hf_json_i64(m,hf_json_field(m,i,"storage_bytes"),&storage)||storage<1048576||storage>68719476736LL||!hf_json_bool(m,hf_json_field(m,i,"credential_sensitive"),&slot->sensitive))goto done;
  slot->uid=(uid_t)uid;slot->gid=(gid_t)gid;slot->storage=storage;slot->ordinal=-1;
  for(size_t k=0;k<count;k++)if(!strcmp(slots[k].id,slot->id)||!strcmp(slots[k].session,slot->session)||!strcmp(slots[k].name,slot->name)||slots[k].uid==slot->uid||slots[k].gid==slot->gid)goto done;
  if(!strcmp(slot->kind,"PREPARATION")){if(preparer>=0||!hf_json_only(m,i,base_keys,9))goto done;preparer=(int)count;strcpy(slot->source,environment);}
  else if(!strcmp(slot->kind,"AGENT")){
   const char *keys[]={"name","kind","slot_id","session_id","uid","gid","isolation_profile","credential_sensitive","storage_bytes","ordinal","worker_paths"};int paths=hf_json_field(m,i,"worker_paths");const char *path_keys[]={"source","home","build","temporary","dirty"};
   if(!hf_json_only(m,i,keys,11)||!hf_json_only(m,paths,path_keys,5)||!hf_json_i64(m,hf_json_field(m,i,"ordinal"),&ordinal)||ordinal<0||ordinal>63||!text(m,paths,"source",slot->source,sizeof slot->source)||!text(m,paths,"home",slot->home,sizeof slot->home)||!text(m,paths,"build",slot->build,sizeof slot->build)||!text(m,paths,"temporary",slot->temporary,sizeof slot->temporary)||!text(m,paths,"dirty",slot->dirty,sizeof slot->dirty)||!below(environment,slot->source)||!below(environment,slot->home)||!below(environment,slot->build)||!below(environment,slot->temporary)||!below(environment,slot->dirty))goto done;
   slot->ordinal=(int)ordinal;for(size_t k=0;k<count;k++)if(slots[k].ordinal==slot->ordinal)goto done;
  }else goto done;
  int account=ensure_account(m,t,slot->uid,slot->gid);if(account!=1){error=account<0?"BOOTSTRAP_OS_ACCOUNT_COLLISION":"BOOTSTRAP_OS_ACCOUNT_PROVISIONING_REFUSED";goto done;}
  FILE *s=open_memstream(&allocation,&allocation_n);if(!s)goto done;fputs("{\"root\":",s);hf_json_write_string(s,slot_root);fprintf(s,",\"slot_id\":\"%s\",\"uid\":%u,\"gid\":%u,\"isolation_profile\":",slot->id,slot->uid,slot->gid);hf_json_write_string(s,slot->profile);fprintf(s,",\"credential_sensitive\":%s,\"boot_id\":\"%s\",\"preparation_digest\":\"%s\",\"config_path\":",slot->sensitive?"true":"false",boot,preparation);hf_json_write_string(s,config);fprintf(s,",\"run_id\":\"%s\",\"boot_generation\":\"%s\",\"storage_bytes\":%lld}",run,generation,(long long)storage);if(fclose(s)){free(allocation);goto done;}
  char *allocated=native("supervisor.slot.allocate",allocation);free(allocation);int ok=allocated&&hf_json_parse(parsed,allocated)&&hf_json_get(parsed,"slot_id",value,sizeof value)&&!strcmp(value,slot->id);free(allocated);if(!ok){error="BOOTSTRAP_SLOT_ALLOCATION_REFUSED";goto done;}count++;
 }
 if(preparer<0||count<2||!private_parent(environment,workspace,slots[preparer].uid,slots[preparer].gid)){error="BOOTSTRAP_WORKSPACE_PARENT_REFUSED";goto done;}
 for(size_t k=0;k<count;k++){
  BootstrapSlot *slot=&slots[k];char state_dir[4096],slot_dir[4096];if(!join(slot_dir,slot_root,slot->id)||!join(state_dir,state,slot->session)||!directory(state_dir,0,0,0700))goto done;
  if(!strcmp(slot->kind,"PREPARATION")){if(!join(slot->home,slot_dir,"home")||!join(slot->temporary,slot_dir,"tmp"))goto done;}
  char *descriptor=NULL;size_t n=0;FILE *s=open_memstream(&descriptor,&n);if(!s)goto done;
  fprintf(s,"{\"session_id\":\"%s\",\"slot_id\":\"%s\",\"repository_id\":\"%s\",\"state_dir\":",slot->session,slot->id,repository);hf_json_write_string(s,state_dir);fputs(",\"runner_binary\":",s);hf_json_write_string(s,binary);fputs(",\"workspace_path\":",s);hf_json_write_string(s,slot->source);fputs(",\"home_path\":",s);hf_json_write_string(s,slot->home);fputs(",\"tmp_path\":",s);hf_json_write_string(s,slot->temporary);fprintf(s,",\"runner_binary_digest\":\"%s\",\"preparation_digest\":\"%s\",\"slot_generation\":\"1\",\"uid\":%u,\"gid\":%u,\"preparation_recipes\":%s}",binary_digest,preparation,slot->uid,slot->gid,recipes);if(fclose(s)){free(descriptor);goto done;}slot->registry=descriptor;
 }
 char *physical=NULL;size_t physical_n=0;if(!hf_slot_inventory(slot_root,boot,preparation,&physical,&physical_n))goto done;
 size_t inventory_n=0;FILE *s=open_memstream(&inventory,&inventory_n);if(!s){free(physical);goto done;}fwrite(physical,1,physical_n-1,s);for(size_t k=0;k<count;k++)fprintf(s,",%s",slots[k].registry);fputc(']',s);free(physical);if(fclose(s))goto done;
 char *registration=NULL;if(asprintf(&registration,"{\"preparation_digest\":\"%s\",\"inventory\":%s}",preparation,inventory)<0)goto done;char *registered=invoke(config,run,bootstrap,"14.1","identity.runner.register",registration);free(registration);if(!registered){error="BOOTSTRAP_RUNNER_REGISTRATION_UNCONFIRMED";goto done;}free(registered);
 for(size_t k=0;k<count;k++){char op[37];operation(bootstrap,slots[k].session,op);char *prepared=invoke(config,run,op,"12.1","runner.registry.prepare",slots[k].registry);if(!prepared){error="BOOTSTRAP_PREPARATION_REGISTRATION_UNCONFIRMED";goto done;}free(prepared);}
 if(!directory(daemon_dir,0,0,0700))goto done;
 char *daemon_raw=NULL;size_t daemon_n=0;s=open_memstream(&daemon_raw,&daemon_n);if(!s)goto done;fputs("{\"transport_config\":",s);hf_json_write_string(s,config);fputs(",\"state_dir\":",s);hf_json_write_string(s,daemon_dir);fprintf(s,",\"organisation_id\":\"%s\",\"slot_root\":",org);hf_json_write_string(s,slot_root);fprintf(s,",\"preparation_digest\":\"%s\",\"heartbeat_interval_ms\":1000}",preparation);if(fclose(s)||!hf_private_write(daemon_config,daemon_raw,daemon_n,1)){free(daemon_raw);goto done;}free(daemon_raw);
 pid_t child=fork();if(child<0)goto done;if(child==0){close(lock);setsid();int null=open("/dev/null",O_RDWR|O_CLOEXEC);if(null>=0){dup2(null,0);dup2(null,1);dup2(null,2);if(null>2)close(null);}FILE *sink=fopen("/dev/null","we");char *daemon_request=NULL;if(sink&&asprintf(&daemon_request,"{\"config_path\":\"%s\"}",daemon_config)>=0){int code=hf_supervisor_daemon(daemon_request,sink);fclose(sink);free(daemon_request);_exit(code);} _exit(78);}
 HfProcessIdentity process={0};int ready=0;char daemon_state[4096];if(!join(daemon_state,daemon_dir,"daemon-state.json"))goto done;
 for(int attempt=0;attempt<600;attempt++){char *state_raw=NULL;size_t state_n=0;int yes=0;if(hf_private_read(daemon_state,HF_BODY_LIMIT,&state_raw,&state_n)&&hf_json_parse(parsed,state_raw)&&hf_json_bool(parsed,hf_json_field(parsed,0,"registered"),&yes)&&yes&&hf_process_identity(child,&process)&&process.state!='Z')ready=1;free(state_raw);if(ready&&attempt>=6)break;ready=0;int status=0;if(waitpid(child,&status,WNOHANG)==child)break;struct timespec delay={0,50000000};nanosleep(&delay,NULL);}
 if(!ready){kill(child,SIGTERM);error="BOOTSTRAP_SUPERVISOR_NOT_REGISTERED";goto done;}
 binding_raw=hf_json_raw(m,b);size_t receipt_n=0;s=open_memstream(&receipt,&receipt_n);if(!s)goto done;fprintf(s,"{\"schema_version\":1,\"kind\":\"FLEET_NATIVE_BOOTSTRAP_RECEIPT_V1\",\"state\":\"REGISTERED\",\"bootstrap_id\":\"%s\",\"manifest_digest\":\"%s\",\"binding\":%s,\"credential_id\":\"%s\",\"inventory\":%s,\"slots\":[",bootstrap,expected,binding_raw,credential,inventory);
 for(size_t k=0;k<count;k++){BootstrapSlot *slot=&slots[k];if(k)fputc(',',s);fprintf(s,"{\"slot\":%d,\"name\":\"%s\",\"slot_id\":\"%s\",\"worker_slot_id\":\"%s\",\"session_id\":\"%s\",\"slot_generation\":\"1\",\"kind\":\"%s\",\"uid\":%u,\"gid\":%u,\"source\":",slot->ordinal,slot->name,slot->id,slot->id,slot->session,slot->kind,slot->uid,slot->gid);hf_json_write_string(s,slot->source);fputs(",\"home\":",s);hf_json_write_string(s,slot->home);fputs(",\"temporary\":",s);hf_json_write_string(s,slot->temporary);fputs(",\"build\":",s);hf_json_write_string(s,slot->build);fputs(",\"dirty\":",s);hf_json_write_string(s,slot->dirty);fputc('}',s);}
 fputs("],\"daemon\":",s);hf_process_json(s,&process);fputs(",\"workspaces_materialized\":false}",s);if(fclose(s)||!hf_private_write(receipt_path,receipt,receipt_n,0)){error="BOOTSTRAP_RECEIPT_RECONCILE_REQUIRED";goto done;}fputs(receipt,out);result=0;
 done:if(result&&error)hf_native_error(out,error);if(lock>=0)close(lock);for(size_t k=0;k<65;k++)free(slots[k].registry);free(inventory);free(receipt);free(recipes);free(binding_raw);free(raw);free(q);free(m);free(parsed);return result;
}

int hf_supervisor_bootstrap(const char *request,FILE *out){return bootstrap(request,out,0);}
int hf_supervisor_bootstrap_stage(const char *request,FILE *out){return bootstrap(request,out,1);}

int hf_supervisor_bootstrap_activate(const char *request,FILE *out){return bootstrap(request,out,2);}
