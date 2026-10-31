#define _GNU_SOURCE
#include "components.h"
#include "supervisor.h"
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int hf_fleet_launch_store(const char *state,const char *launch,const char *encoded,const char *digest,char *destination,size_t capacity){
 if(geteuid()!=0||!hf_uuid_valid(launch)||strlen(digest)!=71||strncmp(digest,"sha256:",7))return 0;
 size_t size=0;unsigned char *decoded=hf_base64url_decode(encoded,&size),*bytes=decoded?malloc(size+1):NULL;char actual[65];if(bytes){memcpy(bytes,decoded,size);bytes[size]=0;}free(decoded);
 int ok=bytes&&size&&size<=HF_BODY_LIMIT&&!memchr(bytes,0,size)&&hf_sha256_bytes(bytes,size,actual)&&!strcmp(actual,digest+7)&&
  snprintf(destination,capacity,"%s/connector-plan-%s.json",state,launch)<(int)capacity;
 if(ok){char *old=NULL;size_t old_size=0;if(!access(destination,F_OK)){ok=hf_private_read(destination,HF_BODY_LIMIT,&old,&old_size)&&old_size==size&&!memcmp(old,bytes,size);free(old);}else ok=hf_private_write(destination,bytes,size,0);}
 if(ok){
  HfJson *plan=calloc(1,sizeof *plan);char profile_path[4200],expected[4096],actual_value[4096];
  ok=plan&&hf_json_parse(plan,(const char *)bytes);int snapshot=ok?hf_json_field(plan,0,"auth_profile_snapshot"):-1;
  const char *keys[]={"profile_digest","auth_profile","connector","requested_model_id","configured_provider_id"};
  const char *profile_keys[]={"profile_digest","profile_id","connector","requested_model_id","configured_provider_id"};
  for(int n=0;ok&&n<5;n++)ok=hf_json_get(plan,keys[n],expected,sizeof expected)&&hf_json_string(plan,hf_json_field(plan,snapshot,profile_keys[n]),actual_value,sizeof actual_value)&&!strcmp(expected,actual_value);
  int binary=ok?hf_json_field(plan,snapshot,"binary"):-1,argv=ok?hf_json_field(plan,0,"argv"):-1;
  ok=ok&&hf_json_get(plan,"binary_digest",expected,sizeof expected)&&hf_json_string(plan,hf_json_field(plan,binary,"digest"),actual_value,sizeof actual_value)&&!strcmp(expected,actual_value)&&argv>=0&&plan->tokens[argv].count>0&&hf_json_string(plan,argv+1,expected,sizeof expected)&&hf_json_string(plan,hf_json_field(plan,binary,"path"),actual_value,sizeof actual_value)&&!strcmp(expected,actual_value);
  char *raw=ok?hf_json_raw(plan,snapshot):NULL;
  ok=ok&&raw&&snprintf(profile_path,sizeof profile_path,"%s/connector-profile-%s.json",state,launch)<(int)sizeof profile_path;
  if(ok){char *old=NULL;size_t old_size=0;if(!access(profile_path,F_OK)){ok=hf_private_read(profile_path,HF_BODY_LIMIT,&old,&old_size)&&old_size==strlen(raw)&&!memcmp(old,raw,old_size);free(old);}else ok=hf_private_write(profile_path,raw,strlen(raw),0);}
  free(raw);free(plan);
 }
 free(bytes);return ok;
}

int hf_fleet_launch_identity(const HfJson *plan,const char *organisation,const char *run,const char *sandbox,const char *boot,const char *generation,const char *slot,const char *attempt,const char *attempt_generation,long long deadline,const char *operation,uid_t *uid,gid_t *gid){
 int b=hf_json_field(plan,0,"fleet_binding"),r=hf_json_field(plan,0,"readiness");char text[4096];int64_t u=0,g=0;
 const char *keys[]={"organisation_id","run_id","sandbox_id","boot_id","boot_generation","slot_id"};
 const char *values[]={organisation,run,sandbox,boot,generation,slot};
 for(int n=0;n<6;n++)if(!hf_json_string(plan,hf_json_field(plan,b,keys[n]),text,sizeof text)||strcmp(text,values[n]))return 0;
 if(!hf_json_get(plan,"attempt_id",text,sizeof text)||strcmp(text,attempt)||!hf_json_get(plan,"attempt_generation",text,sizeof text)||strcmp(text,attempt_generation)||
  !hf_json_string(plan,hf_json_field(plan,r,"kind"),text,sizeof text)||strcmp(text,"FLEET_MANIFEST_V1")||
  !hf_json_i64(plan,hf_json_field(plan,b,"uid"),&u)||u<1||u>2147483647||!hf_json_i64(plan,hf_json_field(plan,b,"gid"),&g)||g<1||g>2147483647)return 0;
 *uid=(uid_t)u;*gid=(gid_t)g;
 const char *paths[]={"cwd","home","temp"},*bindings[]={"workspace_path","home_path","tmp_path"};int binding=hf_json_field(plan,0,"binding");
 for(int n=0;n<3;n++){char expected[4096];struct stat st;if(!hf_json_get(plan,paths[n],text,sizeof text)||!hf_json_string(plan,hf_json_field(plan,binding,bindings[n]),expected,sizeof expected)||strcmp(text,expected)||lstat(text,&st)||!S_ISDIR(st.st_mode)||st.st_uid!=*uid||st.st_gid!=*gid||(st.st_mode&077))return 0;}
 return hf_runner_measure_fleet_launch(plan,0,*uid,*gid,deadline,operation);
}
