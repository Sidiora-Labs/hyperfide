#!/usr/bin/env python3
"""Build twice, verify, and run the extracted native source release package."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parents[4]
OUT=ROOT/'build/source-control/7.1'
REPOSITORY=ROOT.parents[1]
DOCUMENTS=[REPOSITORY/'docs/hyperfide/hyperfide/source-control.md',REPOSITORY/'docs/hyperfide/runtime/source-control.md']
CLAIMS=ROOT/'tests/hyperfide/source-control/claims.json'
REGISTRY=ROOT/'tests/hyperfide/source-control/registry.json'
SOURCE_SPEC=REPOSITORY/'spec/layerx-merge/source-control/source-spec.kvx'

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def require(value,message):
    if not value:raise AssertionError(message)

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()

def documentation_inputs():
    return {str(path.relative_to(REPOSITORY)):digest(path) for path in [*DOCUMENTS,REGISTRY,CLAIMS,SOURCE_SPEC]}

def fences(text):
    """Retain fence labels and source lines; an unclosed example is an error."""
    opened=None;body=[]
    for number,line in enumerate(text.splitlines(),1):
        if opened is None:
            if line.startswith('```'):opened=(line[3:].strip(),number);body=[]
        elif line=='```':
            yield opened[0],opened[1]+1,'\n'.join(body)
            opened=None
        else:body.append(line)
    require(opened is None,'Unclosed documentation fence')

def documented_commands(text,document):
    """Extract every `sh source` line as argv, never shell-evaluate documentation.

    Builder and release-closure examples use `sh builder` / `sh release`.
    Runtime commands must use `sh source`; unsupported executables, shell syntax,
    empty blocks and unlabelled runtime examples refuse rather than disappearing.
    """
    result=[]
    for label,line,body in fences(text):
        if label.split()[:1] not in [['sh'],['bash'],['shell']]:continue
        for offset,value in enumerate(body.splitlines()):
            if not value.strip() or value.lstrip().startswith('#'):continue
            args=shlex.split(value)
            executable=next((arg for arg in args if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*=',arg)),'')
            runtime=Path(executable).name in {'source-control','hyperfide','hyperfide-native'}
            require(not runtime or label=='sh source','Runtime example lacks sh source label: '+document)
            if label!='sh source':continue
            require(args and args[0] in {'source-control','hyperfide','hyperfide-native'},'Documented executable is not in runtime bin')
            require(not any(re.search(r'[|;&<>`$\n]',arg) for arg in args),'Shell syntax is not supported in source examples')
            result.append({'document':document,'line':line+offset,'argv':args})
        if label=='sh source':require(body.strip() and any(item['line']>=line for item in result),'Empty source command fence')
    require(result,'Document has no runnable source commands: '+document)
    return result

def schema_validate(value,schema,location='$'):
    """Evaluate the recovery schema's closed JSON Schema vocabulary, fail closed."""
    known={'$schema','title','description','type','additionalProperties','required','properties','const','enum','minLength','maxLength','pattern','minimum','maximum','items','minItems','maxItems','uniqueItems','allOf','if','then'}
    require(set(schema)<=known,'Unsupported recovery schema keyword at '+location)
    kind=schema.get('type')
    types={'object':dict,'array':list,'string':str,'integer':int,'boolean':bool}
    if kind:require(kind in types and type(value) is types[kind],'Recovery profile type differs at '+location)
    if 'const' in schema:require(type(value) is type(schema['const']) and value==schema['const'],'Recovery profile constant differs at '+location)
    if 'enum' in schema:require(any(type(value) is type(item) and value==item for item in schema['enum']),'Recovery profile enum differs at '+location)
    if isinstance(value,dict):
        require(set(schema.get('required',[]))<=set(value),'Recovery profile required fields missing at '+location)
        properties=schema.get('properties',{})
        if schema.get('additionalProperties') is False:require(set(value)<=set(properties),'Recovery profile unknown fields at '+location)
        for key,child in properties.items():
            if key in value:schema_validate(value[key],child,location+'.'+key)
    if isinstance(value,list):
        require(schema.get('minItems',0)<=len(value)<=schema.get('maxItems',float('inf')),'Recovery profile item bound differs at '+location)
        if schema.get('uniqueItems'):require(len({canonical(item) for item in value})==len(value),'Recovery profile duplicate items at '+location)
        for item in value:
            if 'items' in schema:schema_validate(item,schema['items'],location+'[]')
    if isinstance(value,str):
        require(schema.get('minLength',0)<=len(value)<=schema.get('maxLength',float('inf')),'Recovery profile text bound differs at '+location)
        if 'pattern' in schema:require(re.search(schema['pattern'],value) is not None,'Recovery profile pattern differs at '+location)
    if type(value) is int:require(schema.get('minimum',-float('inf'))<=value<=schema.get('maximum',float('inf')),'Recovery profile number bound differs at '+location)
    for child in schema.get('allOf',[]):schema_validate(value,child,location)
    if 'if' in schema:
        try:schema_validate(value,schema['if'],location)
        except AssertionError:pass
        else:schema_validate(value,schema['then'],location)

def recovery_profile(value,schema):
    schema_validate(value,schema)
    require(value['backup']['maximum_age_seconds']<=value['backup']['retention_seconds'],'Recovery profile backup age exceeds retention')

def consistency(registry,claims,sections):
    """Compare the carried case inventory with registered assertions and claims."""
    require(registry.get('schema_version')==2 and claims.get('schema_version')==1,'Registry or claims schema differs')
    cases={section['name'][5:]:{key:field['value'] for key,field in section['fields'].items()} for section in sections if section['name'].startswith('case.')}
    require(cases and set(cases)==set(registry['cases'])==set(claims['cases']),'Specification/registry/claims case inventory differs')
    for ident,case in cases.items():
        registered=registry['cases'][ident];claim=claims['cases'][ident]
        for key in ['reqs','tasks','status']:require(registered[key]==case[key],'Specification case '+key+' differs: '+ident)
        require(claim['requirement_clauses']==case['reqs'],'Claim requirement inventory differs: '+ident)
        for key in ['required_variants','optional_variants']:
            values=claim.get(key,[])
            require(isinstance(values,list) and (values or key=='optional_variants') and all(isinstance(v,str) and v for v in values) and len(set(values))==len(values),'Claim variant inventory differs: '+ident)
        require(not set(claim.get('optional_variants',[]))&set(claim['required_variants']),'Required and optional variants overlap: '+ident)
        assertions=registered['full_assertion_ids']
        require(isinstance(assertions,list) and assertions and all(isinstance(a,str) and a for a in assertions) and len(set(assertions))==len(assertions),'Full assertion inventory absent or invalid: '+ident)
        if 'full_assertion_ids' in claim:require(claim['full_assertion_ids']==assertions,'Claim assertion inventory differs: '+ident)

def pinned_reference(record):
    require(isinstance(record,dict) and set(record)=={'path','sha256'},'Exact documentation reference required')
    relative=Path(record['path'])
    require(not relative.is_absolute() and '..' not in relative.parts,'Documentation reference escapes repository')
    path=REPOSITORY/relative
    require(not path.is_symlink() and path.resolve().is_relative_to(REPOSITORY) and path.is_file(),'Documentation reference is absent or unsafe')
    require(re.fullmatch('[0-9a-f]{64}',record['sha256']) and digest(path)==record['sha256'],'Stale documentation reference: '+record['path'])
    return path

def evidence_reference(record,manifest):
    path=pinned_reference(record);receipt=json.loads(path.read_text())
    require(receipt.get('status')=='PASS' and receipt.get('scope')=='packaged native source component','Documentation evidence must identify a passing packaged component receipt')
    require(receipt.get('source_inputs_sha256')==manifest['source_inputs_sha256'],'Stale documentation evidence source digest')
    require(receipt.get('checks') and receipt.get('documented_commands'),'Documentation evidence is incomplete')
    require(receipt.get('documentation_inputs')==documentation_inputs(),'Stale documentation evidence input inventory')
    expected=[command for path in DOCUMENTS for command in documented_commands(path.read_text(),str(path.relative_to(REPOSITORY)))]
    observed=[]
    for command in receipt['documented_commands']:
        require(command.get('exit_code')==0 and type(command.get('exit_code')) is int,'Documentation evidence command failed')
        log=Path(command['log'])
        require(log.is_file() and digest(log)==command['log_sha256'],'Stale documentation command log')
        observed.append({key:command[key] for key in ['document','line','argv']})
    require(sorted(map(canonical,observed))==sorted(map(canonical,expected)),'Documentation evidence command inventory differs')

def documentation(text,document,manifest,registry,claims,schema):
    declarations=[json.loads(body) for label,_,body in fences(text) if label=='json source-release']
    require(len(declarations)==1,'One documentation source-release declaration required: '+document)
    declaration=declarations[0]
    require(set(declaration)=={'schema_version','source_refs','evidence_refs','recovery_profiles'} and type(declaration['schema_version']) is int and declaration['schema_version']==1,'Documentation declaration fields differ')
    require(declaration['source_refs'],'Documentation source references are missing')
    for record in declaration['source_refs']:pinned_reference(record)
    for record in declaration['evidence_refs']:evidence_reference(record,manifest)
    for record in declaration['recovery_profiles']:recovery_profile(json.loads(pinned_reference(record).read_text()),schema)
    pins={record['sha256'] for key in ['source_refs','evidence_refs','recovery_profiles'] for record in declaration[key]}
    require(set(re.findall(r'(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])',text))<=pins,'Unbound source/evidence digest in documentation')
    for link in re.findall(r'\[[^\]]*\]\(([^)]+)\)',text):
        if re.search(r'(?:receipt|evidence|closure)[^/]*\.json(?:#.*)?$',link):
            target=(REPOSITORY/document).parent/link.split('#')[0]
            require(any((REPOSITORY/record['path']).resolve()==target.resolve() for record in declaration['evidence_refs']),'Unpinned documentation evidence link')
    if document.endswith('/hyperfide/source-control.md'):
        found=set()
        for line in text.splitlines():
            if not line.startswith('|') or 'claims.json#/cases/' not in line:continue
            cells=[cell.strip() for cell in line.strip('|').split('|')]
            require(len(cells)==4 and cells[2] in {'QUALIFIED','UNQUALIFIED'},'Documentation profile must have an explicit qualification state')
            match=re.fullmatch(r'\[(SCM-\d{3})\]\(([^)]+)#/cases/(SCM-\d{3})\)',cells[3])
            require(match and match[1]==match[3] and match[1] in claims['cases'],'Documentation case link differs from claims')
            require(((REPOSITORY/document).parent/match[2]).resolve()==CLAIMS,'Documentation case link must name current claims.json')
            key=(match[1],cells[1]);claim=claims['cases'][match[1]]
            require(cells[1] in claim['required_variants']+claim.get('optional_variants',[]) and key not in found,'Documentation profile variant differs or repeats')
            require(cells[2]=='UNQUALIFIED' and registry['cases'][match[1]]['status']=='UNRUN','Profile qualification requires a separately checked full-case release closure')
            found.add(key)
        expected={(ident,variant) for ident,claim in claims['cases'].items() for variant in claim['required_variants']+claim.get('optional_variants',[])}
        require(found==expected,'Documentation profile coverage differs from claims')
    return documented_commands(text,document)

def release_manifest(directory,manifest,record):
    path=directory/'source-release-manifest.json';release=json.loads(path.read_text())
    require(release.get('schema_version')==1 and release.get('kind')=='hyperfide-native-source-release-contract','Release manifest kind or schema differs')
    require(digest(path)==record['release_manifest_sha256'],'Release manifest checksum differs')
    require(release['source_inputs_sha256']==manifest['source_inputs_sha256'],'Release source input digest differs')
    for key in ['source_format_version','protocol_version']:require(type(release[key]) is int and release[key]==manifest[key],'Release compatibility version differs')
    inputs=manifest['input_manifest'];expected={key.split('/')[1] for key in inputs if key.startswith('dependencies/')}
    require(expected==set(release['dependencies']) and expected,'Release dependency closure differs')
    for position,pin in release['dependencies'].items():
        prefix='dependencies/'+position+'/'
        inventory={key.removeprefix(prefix):value for key,value in inputs.items() if key.startswith(prefix)}
        require(hashlib.sha256(canonical(inventory)).hexdigest()==pin['content_sha256'],'Release dependency input pin differs')
        require(pin['path']=='services/node_modules/.hyperfide/'+position,'Release dependency path differs')
        package=json.loads((directory/pin['path']/'package.json').read_text())
        require((package['name'],package['version'])==(pin['name'],pin['version']),'Release dependency version differs')
        for name,target in pin['dependencies'].items():
            require(target in expected and (directory/pin['path']/'node_modules'/name).resolve()==(directory/release['dependencies'][target]['path']).resolve(),'Release dependency edge differs')
    for name,target in release['dependency_entries'].items():
        require(target in expected and (directory/'services/node_modules'/name).resolve()==(directory/release['dependencies'][target]['path']).resolve(),'Release dependency entry differs')
    require(set(release['dependency_entries'])==set(json.loads((directory/'services/package.json').read_text())['dependencies']),'Release dependency roots differ')
    upgrade=release['upgrade_compatibility'];migrations={path.name:digest(path) for path in sorted((directory/'services/migrations').glob('*.sql'))}
    require(upgrade['target_migrations']==migrations and upgrade['legacy_migrations']=={name:pin for name,pin in migrations.items() if int(name[:4])<upgrade['first_native_migration']},'Release legacy migration pins differ')
    require(upgrade['profile_id']=='git-source-pre-native-0736-v1' and upgrade['first_native_migration']==736 and upgrade['preserved_tables']==['source_objects','spec_revisions'],'Release legacy migration profile differs')
    require(upgrade['legacy_object_namespace']=='git:sha1:' and upgrade['native_object_namespace']=='sha256:','Release object compatibility namespaces differ')
    require(upgrade['deployment_qualification']=='UNQUALIFIED' and upgrade['legacy_backup_restore']=='REFUSED_BACKUP_FORMAT_UNSUPPORTED' and upgrade['backup_manifest_version']==2 and upgrade['source_cutover']=='REQUIRES_SEPARATE_QUALIFIED_MIGRATION','Release upgrade boundary differs')
    return release

def parse_source_spec(runtime,env):
    script="import fs from 'node:fs';import {pathToFileURL} from 'node:url';const {parseKvx}=await import(pathToFileURL(process.argv[1]));console.log(JSON.stringify(parseKvx(fs.readFileSync(process.argv[2],'utf8')).sections));"
    return json.loads(subprocess.check_output([str(runtime/'runtime/node'),'--input-type=module','-e',script,str(runtime/'services/dist/spec/import.js'),str(SOURCE_SPEC)],env=env,text=True))

def run_documented_cli(runtime,env,commands,work):
    """Execute the extracted request examples against the packaged signed service."""
    spec=importlib.util.spec_from_file_location('package_identity_fixture',ROOT/'tests/hyperfide/support/identity_fixture.py')
    identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
    harness=work/'signed-runtime';(harness/'core').mkdir(parents=True)
    (harness/'core/control-plane').symlink_to(runtime/'services',target_is_directory=True)
    identity.ROOT=harness
    backend_script="import {createSourceS3Fixture} from "+json.dumps((ROOT/'tests/hyperfide/cases/source_control/fixtures/objects/backend.mjs').as_uri())+";const f=await createSourceS3Fixture();console.log(JSON.stringify(f.config));process.once('SIGTERM',async()=>{await f.close();process.exit(0)});"
    backend=subprocess.Popen([str(runtime/'runtime/node'),'--input-type=module','-e',backend_script],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    fixture=None;previous=os.environ.get('PATH');results=[]
    try:
        import select
        require(select.select([backend.stdout],[],[],15)[0],'Documentation object backend readiness timed out')
        storage=json.loads(backend.stdout.readline())
        source_env={'HF_SOURCE_S3_ENDPOINT':storage['endpoint'],'HF_SOURCE_S3_REGION':storage['region'],'HF_SOURCE_S3_BUCKET':storage['bucket'],'HF_SOURCE_S3_ACCESS_KEY_ID':storage['accessKey'],'HF_SOURCE_S3_SECRET_ACCESS_KEY':storage['secretKey'],'HF_SOURCE_ALLOW_LOOPBACK_HTTP':'1','HF_SOURCE_CURSOR_KEY':'c2lnbmVkLXNvdXJjZS10cmFuc3BvcnQtZml4dHVyZS1rZXk','HF_SOURCE_CACHE_BYTES':'16777216','HF_SOURCE_CACHE_ENTRIES':'1024','HF_SOURCE_MAX_FILE_BYTES':'8388608','HF_SOURCE_MATERIALIZED_BYTES':'67108864','HF_SOURCE_DIRTY_BYTES':'16777216'}
        import uuid
        scope={'organisation_id':None,'repository_id':str(uuid.uuid4()),'security_domain_id':str(uuid.uuid4())}
        def setup(current):
            scope['organisation_id']=current.ids['organisation']
            policy=current.path/'source-authorization.json'
            policy.write_text(json.dumps({'schema_version':1,'rules':[{'role':'OPERATOR','actions':current.actions,'repositories':[scope['repository_id']],'artifact_prefixes':[],'git_refs':[],'model_destinations':[],'model_profiles':[]}]}));policy.chmod(0o600)
            current.env['HF_AUTHORIZATION_CONFIG_FILE']=str(policy)
            current.sql('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,$4)',[*scope.values(),'packaged-docs-v1'])
            current.sql("INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$5,'automation',1,$6,$7,ARRAY[''],clock_timestamp()+interval '15 minutes')",[*scope.values(),str(uuid.uuid4()),current.ids['operator'],'packaged-docs-v1',['source.capabilities']])
        os.environ['PATH']=str(runtime/'runtime')+':'+env['PATH']
        fixture=identity.IdentityFixture(extra_components=['source-control','14.4'],extra_env=source_env,extra_setup=setup)
        configuration=fixture.path/'source-client.json'
        configuration.write_text(json.dumps({'schema_version':1,'endpoint':fixture.origin+'/api/v1/source-control','scope':scope,'credential_id':fixture.ids['operator'],'ca_file':str(fixture.ca),'key_file':str(fixture.keys['operator']['path'])}));configuration.chmod(0o600)
        request=fixture.path/'request.json'
        request.write_text(json.dumps({'protocol_version':1,'scope':scope,'operation_id':str(uuid.uuid4()),'action':'source.capabilities','input':{}}));request.chmod(0o600)
        command_env={**fixture.env,'HF_SOURCE_CONFIG':str(configuration)}
        for index,command in enumerate(commands):
            args=command['argv'];require(args[0]!='source-control','Startup command must run through packaged readiness smoke')
            result=subprocess.run([str(runtime/'bin'/args[0]),*args[1:]],cwd=fixture.path,env=command_env,text=True,capture_output=True,timeout=30)
            log=OUT/('documented-cli-'+str(index)+'.log');log.write_text(result.stdout+result.stderr)
            require(result.returncode==0,'Documented source command failed: '+shlex.join(args)+'; log '+str(log))
            if args[:2]==['hyperfide','source'] and 'invoke' in args and '--help' not in args:
                response=json.loads(result.stdout)
                require(response.get('operation_id')==json.loads(request.read_text())['operation_id'] and 1 in response['result']['protocol_versions'],'Documented signed CLI response differs')
            else:require(result.stdout.strip(),'Documented command returned no observable output')
            results.append({**command,'executable':str(runtime/'bin'/args[0]),'exit_code':result.returncode,'log':str(log),'log_sha256':digest(log)})
        refused=subprocess.run([str(runtime/'bin/hyperfide'),'source','invoke','--request-file','missing-request.json'],cwd=fixture.path,env=command_env,text=True,capture_output=True,timeout=30)
        require(refused.returncode!=0 and 'INVALID_SOURCE_REQUEST' in refused.stderr,'Invalid documented source request was not refused')
    finally:
        try:
            if fixture:fixture.close()
        finally:
            if previous is None:os.environ.pop('PATH',None)
            else:os.environ['PATH']=previous
            backend.terminate()
            try:backend.communicate(timeout=10)
            except subprocess.TimeoutExpired:backend.kill();backend.communicate()
            require(backend.returncode==0,'Documentation object backend cleanup failed')
    return results

def refusal_probes(runtime,manifest,record,registry,claims,sections,schema,profile,evidence):
    checks=[]
    def refused(name,callback,needle):
        try:callback()
        except AssertionError as error:require(needle in str(error),'Wrong refusal for '+name+': '+str(error))
        else:raise AssertionError('Missing refusal: '+name)
        checks.append(name)
    for text in ['```sh\nhyperfide source --help\n```','```sh source\n/bin/hyperfide source --help\n```','```sh source\nhyperfide source --help ; true\n```','```sh source\n```','```sh source\nhyperfide source --help']:
        refused('malformed or unlabelled source command refused',lambda:documented_commands(text,'negative-doc'),'')
    document=str(DOCUMENTS[0].relative_to(REPOSITORY));text=DOCUMENTS[0].read_text()
    declaration=next(json.loads(body) for label,_,body in fences(text) if label=='json source-release')
    stale=copy.deepcopy(declaration['source_refs'][0]);stale['sha256']='0'*64
    refused('stale documented source digest refused',lambda:pinned_reference(stale),'Stale documentation reference')
    valid_evidence={'path':str(evidence.relative_to(REPOSITORY)),'sha256':digest(evidence)}
    evidence_reference(valid_evidence,manifest)
    stale=copy.deepcopy(valid_evidence);stale['sha256']='0'*64
    refused('stale evidence reference refused',lambda:evidence_reference(stale,manifest),'Stale documentation reference')
    original=evidence.read_bytes();receipt=json.loads(original)
    try:
        for field,value,needle in [('source_inputs_sha256','0'*64,'Stale documentation evidence source digest'),('status','FAIL','passing packaged component receipt'),('checks',[],'incomplete'),('documentation_inputs',{},'Stale documentation evidence input inventory'),('documented_commands',receipt['documented_commands'][:-1],'command inventory differs')]:
            changed={**receipt,field:value};evidence.write_bytes(canonical(changed))
            refused('inapplicable evidence '+field+' refused',lambda:evidence_reference({**valid_evidence,'sha256':digest(evidence)},manifest),needle)
    finally:evidence.write_bytes(original)
    false_claim=re.sub(r'\|\s*UNQUALIFIED\s*\|','| QUALIFIED |',text,count=1)
    refused('unqualified profile cannot claim qualification',lambda:documentation(false_claim,document,manifest,registry,claims,schema),'Profile qualification requires')
    def missing_fields(value,node,path=()):
        if isinstance(value,dict):
            for key in node.get('required',[]):
                changed=copy.deepcopy(profile);parent=changed
                for part in path:parent=parent[part]
                del parent[key]
                refused('incomplete recovery profile '+'.'.join(map(str,(*path,key)))+' refused',lambda:recovery_profile(changed,schema),'required fields missing')
            for key,item in value.items():
                if key in node.get('properties',{}):missing_fields(item,node['properties'][key],(*path,key))
        elif isinstance(value,list):
            for index,item in enumerate(value):missing_fields(item,node['items'],(*path,index))
    missing_fields(profile,schema)
    for changes,needle in [({'schema_version':True},'type differs'),({'metadata':{**profile['metadata'],'acknowledgment':'SYNC_REPLICA','replica_failure_domains':[]}},'item bound'),({'metadata':{**profile['metadata'],'supported_failures':['FAILURE_DOMAIN_LOSS']}},'enum differs'),({'metadata':{**profile['metadata'],'evidence_digest':'sha256:stale'}},'pattern differs'),({'backup':{**profile['backup'],'maximum_age_seconds':profile['backup']['retention_seconds']+1}},'age exceeds'),({'placements':[]},'item bound'),({'objectives':{**profile['objectives'],'rpo_seconds':-1}},'number bound'),({'unexpected':True},'unknown fields')]:
        refused('invalid recovery profile policy refused',lambda:recovery_profile({**profile,**changes},schema),needle)
    for target in ['registry','claims','spec']:
        altered_registry=copy.deepcopy(registry);altered_claims=copy.deepcopy(claims);altered_sections=copy.deepcopy(sections)
        if target=='spec':altered_sections=[s for s in altered_sections if s['name']!='case.SCM-001']
        else:({'registry':altered_registry,'claims':altered_claims}[target])['cases'].pop('SCM-001')
        refused(target+' case inventory drift refused',lambda:consistency(altered_registry,altered_claims,altered_sections),'case inventory differs')
    for target,key,value,needle in [('registry','reqs',[],'case reqs differs'),('registry','tasks',[],'case tasks differs'),('registry','status','PASS','case status differs'),('registry','full_assertion_ids',[],'assertion inventory'),('claims','requirement_clauses',[],'Claim requirement'),('claims','required_variants',[],'Claim variant'),('claims','full_assertion_ids',[],'Claim assertion')]:
        altered_registry=copy.deepcopy(registry);altered_claims=copy.deepcopy(claims)
        ({'registry':altered_registry,'claims':altered_claims}[target])['cases']['SCM-023'][key]=value
        refused(target+' '+key+' drift refused',lambda:consistency(altered_registry,altered_claims,sections),needle)
    altered_claims=copy.deepcopy(claims);altered_claims['cases']['SCM-015']['optional_variants']=['github']
    refused('mandatory variant cannot become optional',lambda:consistency(registry,altered_claims,sections),'variants overlap')
    release_path=runtime/'source-release-manifest.json';original=release_path.read_bytes();release=json.loads(original)
    try:
        for key in ['source_format_version','protocol_version','dependencies','upgrade_compatibility']:
            changed=copy.deepcopy(release)
            if key=='upgrade_compatibility':changed[key]['legacy_migrations']={}
            else:changed[key]={} if key=='dependencies' else 999
            release_path.write_bytes(canonical(changed))
            refused('release '+key+' drift refused',lambda:release_manifest(runtime,manifest,{**record,'release_manifest_sha256':digest(release_path)}),'Release')
        for field,value in [('content_sha256','0'*64),('version','stale'),('dependencies',{'unregistered-dependency':'missing'})]:
            changed=copy.deepcopy(release);position=next(iter(changed['dependencies']));changed['dependencies'][position][field]=value
            release_path.write_bytes(canonical(changed))
            refused('release dependency '+field+' drift refused',lambda:release_manifest(runtime,manifest,{**record,'release_manifest_sha256':digest(release_path)}),'Release dependency')
    finally:release_path.write_bytes(original)
    return checks

def verify(directory):
    manifest=json.loads((directory/'runtime-manifest.json').read_text())
    inputs=manifest.get('input_manifest')
    if not isinstance(inputs,dict) or hashlib.sha256(json.dumps(inputs,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()!=manifest['source_inputs_sha256']:
        raise AssertionError('Package source input closure differs')
    files=manifest['files']
    actual={path.relative_to(directory).as_posix() for path in directory.rglob('*') if (path.is_file() or path.is_symlink()) and path.relative_to(directory).as_posix()!='runtime-manifest.json'}
    if actual!=set(files):raise AssertionError('Package file inventory differs')
    for name,record in files.items():
        path=directory/name
        if record['kind']=='symlink':
            if not path.is_symlink() or os.readlink(path)!=record['target'] or not path.resolve().is_relative_to(directory):raise AssertionError('Unsafe package dependency link')
        elif path.is_symlink() or not path.is_file() or digest(path)!=record['sha256'] or path.stat().st_size!=record['size'] or (path.stat().st_mode&0o777)!=record['mode']:
            raise AssertionError('Package artifact differs: '+name)
    return manifest

def guard_checks():
    spec=importlib.util.spec_from_file_location('source_package',ROOT/'deploy/hyperfide/source-control/package.py')
    package=importlib.util.module_from_spec(spec);spec.loader.exec_module(package)
    with tempfile.TemporaryDirectory(prefix='hf-package-guards-') as temporary:
        root=Path(temporary);service=root/'service'
        for name in ['dist','components','migrations']:(service/name).mkdir(parents=True)
        (service/'dist/.source-digest.json').write_text('{}');component=service/'components/a.json';component.write_text('{}');migration=service/'migrations/a.sql';migration.write_text('SELECT 1;')
        before=package.input_digest(service);component.write_text('{"changed":true}')
        if before==package.input_digest(service):raise AssertionError('Component bytes missing from package input closure')
        before=package.input_digest(service);migration.write_text('SELECT 2;')
        if before==package.input_digest(service):raise AssertionError('Migration bytes missing from package input closure')
        source=root/'dependency';source.mkdir();outside=root/'outside';outside.write_text('private canary');(source/'alias').symlink_to(outside)
        try:package.tree_records(source)
        except RuntimeError:pass
        else:raise AssertionError('External dependency link would copy outside bytes')
        sdk=root/'sdk';sdk.mkdir()
        refused=subprocess.run([os.environ.get('HYPERFIDE_NODE_BINARY','node'),str(ROOT/'deploy/hyperfide/source-control/bundle.mjs'),'--inputs','--sdk-root',str(sdk)],capture_output=True,text=True)
        if refused.returncode==0 or 'inside the builder workspace' not in refused.stderr or list(sdk.iterdir()):raise AssertionError('External SDK snapshot was not refused before writing')
    return ['component and migration input drift refused','outside dependency symlink refused','outside SDK snapshot refused before writes']

def dependency_resolution_checks(node,service):
    """Use the real installed service closure to prove the vendored boundary."""
    spec=importlib.util.spec_from_file_location('source_package_dependencies',ROOT/'deploy/hyperfide/source-control/package.py')
    package=importlib.util.module_from_spec(spec);spec.loader.exec_module(package)
    resolved=subprocess.run([str(node),'-e',package.DEPENDENCIES,str(service),str(ROOT)],text=True,capture_output=True)
    require(resolved.returncode==0,'Service dependency closure failed: '+resolved.stderr)
    graph=json.loads(resolved.stdout)['graph']
    peer='@cfworker/json-schema'
    outside=REPOSITORY/'node_modules'/peer/'package.json'
    require(outside.is_file() and not outside.resolve().is_relative_to(ROOT),'Qualification repository must supply the outside optional JSON schema peer')
    require(json.loads(outside.read_text())['name']==peer,'Outside optional peer identity differs')
    sdks=[(filename,record) for filename,record in graph.items() if record['name']=='@modelcontextprotocol/sdk']
    require(sdks,'Service dependency closure must include the MCP SDK')
    for filename,record in sdks:
        installed=json.loads(Path(filename).read_text())
        require(installed['peerDependencies'][peer]=='^4.1.1' and installed['peerDependenciesMeta'][peer]['optional'] is True,'MCP optional JSON schema peer declaration differs')
        require(peer not in record['deps'],'Outside optional JSON schema peer entered the MCP dependency closure')
    require(all(record['name']!=peer for record in graph.values()),'Outside optional JSON schema peer entered the release closure')
    require(all(Path(filename).resolve().is_relative_to(ROOT) for filename in graph),'Dependency closure escaped the vendored tree')
    streams=[record for record in graph.values() if record['name']=='readable-stream']
    require(streams,'Service closure must include the installed stream dependencies')
    for record in streams:
        require('string_decoder' in record['deps'] and graph[record['deps']['string_decoder']]['name']=='string_decoder','Required npm package sharing a Node built-in name was omitted')
    # Restrict the same resolver to the built dist directory: its real service
    # manifest still requires production packages, but none are installed there.
    refused=subprocess.run([str(node),'-e',package.DEPENDENCIES,str(service),str(service/'dist')],text=True,capture_output=True)
    required=next(iter(json.loads((service/'package.json').read_text())['dependencies']))
    require(refused.returncode!=0 and 'Missing named package '+required+' required by '+str(service/'package.json') in refused.stderr,'Missing required dependency must name its package and requiring file')
    return ['repository-only optional MCP JSON schema peer omitted from the installed service closure','service dependency closure stays within the vendored tree','required npm packages sharing Node built-in names are included','missing required dependency names the package and requiring file']

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--package-only',action='store_true');parser.add_argument('--service-root');parser.add_argument('--sdk-root');parser.add_argument('--label',default='current-source');parser.add_argument('--package-dir',help='Verify and smoke an already assembled package');args=parser.parse_args()
    if not args.package_only and not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]],cwd=ROOT).returncode
    selected_node=os.environ.get('HYPERFIDE_NODE_BINARY') or shutil.which('node')
    require(selected_node,'Pinned Node runtime is required')
    node=Path(selected_node).resolve()
    OUT.mkdir(parents=True,exist_ok=True)
    dependency_checks=[]
    with tempfile.TemporaryDirectory(prefix='hf-source-release-build-') as temporary:
        work=Path(temporary);records=[]
        if args.package_dir:
            existing=Path(args.package_dir).resolve()
            record=json.loads((existing/'package-manifest.json').read_text())
            archive_source=existing/record['artifact']['path']
            if digest(archive_source)!=record['artifact']['sha256'] or archive_source.stat().st_size!=record['artifact']['size']:
                raise AssertionError('Assembled package checksum differs')
            (work/'first').mkdir()
            shutil.copyfile(archive_source,work/'first'/archive_source.name)
            shutil.copyfile(existing/'package-manifest.json',work/'first/package-manifest.json')
            shutil.copyfile(existing/'source-release-manifest.json',work/'first/source-release-manifest.json')
            records=[record,record]
        else:
            dependency_checks=dependency_resolution_checks(node,Path(args.service_root).resolve() if args.service_root else ROOT/'core/control-plane')
            # The declared `make all` gate builds the main CLI. Assemble the
            # separate component executable explicitly on this release builder;
            # package.py still independently refuses missing or stale outputs.
            native_command=['make','hyperfide-native']
            native=subprocess.run(native_command,cwd=ROOT,text=True,capture_output=True,timeout=300)
            native_log=OUT/'native-components-build.log';native_log.write_text(native.stdout+native.stderr)
            require(native.returncode==0,'Native component assembly failed; log '+str(native_log))
            for name in ['first','second']:
                directory=work/name
                result=subprocess.run([sys.executable,str(ROOT/'deploy/hyperfide/source-control/package.py'),'--output',str(directory),'--node',str(node),*(['--service-root',args.service_root] if args.service_root else []),*(['--sdk-root',args.sdk_root] if args.sdk_root else [])],cwd=ROOT,text=True,capture_output=True,timeout=300)
                if result.returncode:raise RuntimeError(result.stdout+result.stderr)
                records.append(json.loads(result.stdout.splitlines()[-1]))
        for name,record in zip(['first','second'],records):
            (OUT/('package-'+name+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        if records[0]!=records[1]:
            if records[0]['source_inputs_sha256']!=records[1]['source_inputs_sha256']:
                raise AssertionError('Runtime source changed between reproducibility builds')
            details=[]
            manifests=[]
            for name in ['first','second']:
                with tarfile.open(work/name/'native-source-runtime.tar.gz') as bundle:
                    manifests.append(json.load(bundle.extractfile('runtime-manifest.json')))
            for name in sorted(set(manifests[0]['files'])|set(manifests[1]['files'])):
                if manifests[0]['files'].get(name)!=manifests[1]['files'].get(name):details.append(name)
            raise AssertionError('Same release inputs did not reproduce package files: '+', '.join(details[:20]))
        destination=OUT/'artifacts'/records[0]['artifact']['sha256'];destination.mkdir(parents=True,exist_ok=True)
        for name in [records[0]['artifact']['path'],'package-manifest.json','source-release-manifest.json']:
            target=destination/name
            if target.exists() and target.read_bytes()!=(work/'first'/name).read_bytes():raise AssertionError('Existing immutable release artifact differs')
            shutil.copyfile(work/'first'/name,target)
        archive=work/'first'/records[0]['artifact']['path'];runtime=work/'runtime';runtime.mkdir()
        with tarfile.open(archive) as bundle:bundle.extractall(runtime,filter='data')
        manifest=verify(runtime)
        require(digest(runtime/'runtime-manifest.json')==records[0]['runtime_manifest_sha256'],'Runtime manifest checksum differs')
        release=release_manifest(runtime,manifest,records[0])
        require(all(pin['name']!='@cfworker/json-schema' for pin in release['dependencies'].values()),'Repository-only optional JSON schema peer entered the packaged release closure')
        require((runtime/'source-release-manifest.json').read_bytes()==(work/'first/source-release-manifest.json').read_bytes(),'External release manifest differs from archive')
        env={**os.environ,'PATH':str(runtime/'bin')+':'+os.environ.get('PATH',''),'LD_LIBRARY_PATH':str(runtime/'lib/hyperfide'),'HF_SOURCE_PACKAGE_ROOT':str(runtime)}
        if subprocess.check_output([str(runtime/'runtime/node'),'--version'],env=env,text=True).strip()!=manifest['node_version']:raise AssertionError('Packaged Node version differs')
        registry=json.loads(REGISTRY.read_text());claims=json.loads(CLAIMS.read_text());schema=json.loads((runtime/'recovery-profile.schema.json').read_text())
        require((runtime/'recovery-profile.schema.json').read_bytes()==(ROOT/'deploy/hyperfide/source-control/recovery-profile.schema.json').read_bytes(),'Packaged recovery schema differs')
        sections=parse_source_spec(runtime,env);consistency(registry,claims,sections)
        commands=[]
        for path in DOCUMENTS:commands.extend(documentation(path.read_text(),str(path.relative_to(REPOSITORY)),manifest,registry,claims,schema))
        command_file=work/'documented-commands.json';command_file.write_text(json.dumps(commands))
        env.update(HF_SOURCE_DOCUMENTED_COMMANDS=str(command_file),HF_SOURCE_EVIDENCE_DIR=str(OUT))
        checks=[*dependency_checks,*guard_checks(),*(['reproducible archive bytes'] if not args.package_dir else []),'complete package checksums and internal dependency links','packaged pinned Node runtime','release versions, pinned dependency closure and legacy migration compatibility','specification, registry and claims inventories agree','documentation source pins and profile declarations are current']
        command_results=[]
        if not args.package_only:
            result=subprocess.run([str(runtime/'runtime/node'),str(ROOT/'tests/hyperfide/support/native_source_package_smoke.mjs')],cwd=runtime,env=env,text=True,capture_output=True,timeout=300)
            (OUT/'package-smoke.log').write_text(result.stdout+result.stderr)
            if result.returncode:raise RuntimeError(result.stdout+result.stderr)
            smoke=json.loads(result.stdout.splitlines()[-1]);checks.extend(smoke['checks']);command_results.extend(smoke['documented_commands'])
            recovery_profile(smoke['recovery_profile'],schema)
            command_results.extend(run_documented_cli(runtime,env,[command for command in commands if command['argv'][0]!='source-control'],work))
            require(len(command_results)==len(commands),'Not every documented source command executed')
            evidence=OUT/'package-smoke.json'
            evidence.write_text(json.dumps({**smoke,'scope':'packaged native source component','source_inputs_sha256':manifest['source_inputs_sha256'],'documented_commands':command_results,'documentation_inputs':documentation_inputs()},indent=2)+'\n')
            checks.extend(refusal_probes(runtime,manifest,records[0],registry,claims,sections,schema,smoke['recovery_profile'],evidence))
            checks.extend(['every fenced source command executes through the extracted bin directory','invalid documented native request refused','complete recovery declaration validated against packaged schema'])
        destination=OUT/'artifacts'/records[0]['artifact']['sha256'];destination.mkdir(parents=True,exist_ok=True)
        for name in [records[0]['artifact']['path'],'package-manifest.json','source-release-manifest.json']:
            target=destination/name
            if target.exists() and target.read_bytes()!=(work/'first'/name).read_bytes():raise AssertionError('Existing immutable release artifact differs')
            shutil.copyfile(work/'first'/name,target)
        revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPOSITORY,text=True).strip()
        report={'schema_version':1,'status':'PASS','revision':revision,'label':args.label,'scope':'packaged native source component' if not args.package_only else 'package assembly only','source_inputs_sha256':manifest['source_inputs_sha256'],'checks':checks,'documented_commands':command_results,'documentation_inputs':documentation_inputs(),'artifact':str(destination/records[0]['artifact']['path']),'artifact_sha256':records[0]['artifact']['sha256'],'release_manifest_sha256':records[0]['release_manifest_sha256'],'files':len(manifest['files'])}
        (OUT/'receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
    return 0
if __name__=='__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError,AssertionError,OSError,ValueError,subprocess.SubprocessError) as error:
        OUT.mkdir(parents=True,exist_ok=True)
        report={'schema_version':1,'status':'FAIL','scope':'packaged native source component','diagnostics':[str(error)]}
        (OUT/'receipt.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))
        raise SystemExit(1)
