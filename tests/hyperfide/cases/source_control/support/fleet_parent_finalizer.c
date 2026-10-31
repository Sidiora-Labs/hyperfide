#include "supervisor.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static char *read_all(const char *path){FILE *f=fopen(path,"rb");if(!f)return NULL;fseek(f,0,SEEK_END);long n=ftell(f);rewind(f);char *s=calloc((size_t)n+1,1);if(!s||fread(s,1,(size_t)n,f)!=(size_t)n){free(s);s=NULL;}fclose(f);return s;}
int main(int argc,char **argv){
 if(argc!=7)return 2;HfPreparationStage stage={0};
 snprintf(stage.stage_root,sizeof stage.stage_root,"%s",argv[1]);snprintf(stage.workspace_parent,sizeof stage.workspace_parent,"%s",argv[2]);snprintf(stage.workspace_path,sizeof stage.workspace_path,"%s",argv[3]);stage.uid=61941;stage.gid=61941;
 char *claim=read_all(argv[4]),*prepared=read_all(argv[5]),*proof=NULL;HfJson *j=calloc(1,sizeof *j);struct timespec now;clock_gettime(CLOCK_MONOTONIC,&now);
 int ok=claim&&prepared&&j&&hf_json_parse(j,claim)&&hf_runner_finalize_fleet_install(j,0,&stage,(const unsigned char*)prepared,strlen(prepared),NULL,0,(long long)now.tv_sec*1000000000LL+now.tv_nsec+10000000000LL,&proof);
 if(ok&&proof)puts(proof);free(claim);free(prepared);free(j);free(proof);return ok==atoi(argv[6])?0:1;
}
