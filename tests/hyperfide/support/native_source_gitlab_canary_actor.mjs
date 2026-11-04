import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {runHostedSourceCanary} from './native_source_hosted_canary.mjs';
const token=process.env.GITLAB_TOKEN;
assert(typeof token==='string'&&token.length>0&&!/[\r\n]/.test(token),'GITLAB_TOKEN is required');
async function api(route,body){
 const response=await fetch('https://gitlab.com/api/v4/'+route,{method:body?'POST':'GET',headers:{'private-token':token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
 assert(response.ok,'GitLab API request failed with HTTP '+response.status);return response.json();
}
const user=await api('user');
const requested=process.env.HF_CANARY_GITLAB_PROJECT;
let project;
if(requested){
 assert.match(requested,/^[A-Za-z0-9_.-]+\/hyperfide-source-canary-[A-Za-z0-9-]+$/);
 project=await api('projects/'+encodeURIComponent(requested));
}else{
 const name='hyperfide-source-canary-'+new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14)+'-'+randomUUID().slice(0,8);
 project=await api('projects',{name,path:name,visibility:'private',initialize_with_readme:false});
}
assert.equal(project.visibility,'private');assert.equal(project.namespace.kind,'user');assert.equal(project.namespace.path.toLowerCase(),user.username.toLowerCase());
const inventory={provider:'gitlab',project_id:project.id,repository:project.path_with_namespace,url:project.web_url,private:true,created_by_canary:!requested,disposition:'retained private disposable repository for receipt inspection'};
await fs.mkdir('build/source-control/gitlab-canary',{recursive:true});await fs.writeFile('build/source-control/gitlab-canary/inventory.json',JSON.stringify(inventory,null,2)+'\n');
await runHostedSourceCanary({provider:'gitlab',repository:project.path_with_namespace,remote:project.http_url_to_repo,authorization:'Basic '+Buffer.from('oauth2:'+token).toString('base64')});
