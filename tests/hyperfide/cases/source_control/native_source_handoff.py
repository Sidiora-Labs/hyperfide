#!/usr/bin/env python3
"""Execute the native source handoff filesystem boundary with declared wire inputs."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[4]
OUTPUT = ROOT / 'build/source-control/native-handoff'


def run(*args, ok=True, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if ok and result.returncode:
        raise AssertionError(result.stderr.decode(errors='replace'))
    return result


def write_json(path, value):
    path.write_text(json.dumps(value, separators=(',', ':')))
    path.chmod(0o600)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Native handoff ownership checks require root')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='hf-native-source-handoff-') as temporary:
        root = Path(temporary)
        root.chmod(0o711)
        state = root / 'state'
        state.mkdir(mode=0o700)
        home = root / 'worker-home'
        home.mkdir(mode=0o700)
        uid, gid = 62561, 62561
        os.chown(home, uid, gid)
        workspace = root / 'workspace'
        workspace.mkdir(mode=0o700)
        original = b'[source]\nsource_backend = "native"\n'
        (workspace / '.neron').write_bytes(original)
        ids = {key: str(uuid.uuid4()) for key in ['organisation', 'run', 'sandbox', 'boot', 'launch', 'session', 'attempt', 'slot', 'workspace', 'assignment', 'task', 'repository', 'domain', 'capability', 'credential']}
        ids.update(state=str(state), transport=str(state / 'transport.json'), uid=uid, gid=gid)
        body = {'schema_version': 1, 'scope': {'organisation_id': ids['organisation'], 'repository_id': ids['repository'], 'security_domain_id': ids['domain']},
                'assignment_id': ids['assignment'], 'assignment_generation': '1', 'run_id': ids['run'], 'task_id': ids['task'],
                'attempt_id': ids['attempt'], 'attempt_generation': '1', 'workspace_id': ids['workspace'],
                'worker_principal_id': ids['session'], 'capability_id': ids['capability'],
                'base_revision_id': 'sha256:' + '1' * 64, 'root_tree_id': 'sha256:' + '2' * 64,
                'authority': {'authority_epoch': '1', 'generation': '1', 'policy_version': 'native-handoff',
                              'workspace': {'workspace_id': ids['workspace'], 'workspace_generation': '1'},
                              'managed': {'task_id': ids['task'], 'attempt_id': ids['attempt'], 'attempt_generation': '1'}}}
        enrollment = {'credential_id': ids['credential'], 'actor_id': ids['session'], 'run_id': ids['run'], 'role': 'WORKER',
                      'sandbox_id': ids['sandbox'], 'boot_id': ids['boot'], 'boot_generation': '1',
                      'native_source': {'schema_version': 1, 'assignment': body}}
        enrollment_path = state / ('source-enrollment-' + ids['launch'] + '.json')
        write_json(enrollment_path, enrollment)
        plan = {'home': str(home), 'native_source': {key: body[key] for key in ['assignment_id', 'workspace_id', 'worker_principal_id', 'run_id', 'task_id', 'attempt_id', 'attempt_generation']},
                'readiness': {'source_backend': 'native', 'source_object_id': body['base_revision_id'], 'source_tree_id': body['root_tree_id'],
                              'source_repository_id': ids['repository'], 'security_domain_id': ids['domain']}}
        plan_path = state / 'plan.json'
        write_json(plan_path, plan)
        ids['plan'] = str(plan_path)
        fixture = state / 'fixture.json'
        write_json(fixture, ids)
        ca = state / 'ca.pem'
        ca.write_text('-----BEGIN CERTIFICATE-----\ndeclared public fixture\n-----END CERTIFICATE-----\n')
        ca.chmod(0o600)
        write_json(state / 'transport.json', {'origin': 'https://source.example.test', 'ca_file': str(ca), 'key_path': str(state / 'runner.pem'), 'credential_id': ids['credential'], 'run_id': ids['run']})
        launcher_c = root / 'launcher.c'
        launcher_c.write_text('#include ' + json.dumps(str(ROOT / 'core/native/src/hyperfide/launch.c')) + r'''
int main(int argc,char **argv){
 if(argc==3&&!strcmp(argv[1],"keygen")){char key[44];int ok=hf_transport_keygen(argv[2],key);if(ok)puts(key);return ok?0:1;}
 if(argc==3&&!strcmp(argv[1],"public")){char key[44];int ok=hf_transport_public_key(argv[2],key);if(ok)puts(key);return ok?0:1;}
 if(argc!=2)return 2;
 char *text=NULL,*raw=NULL;size_t n=0;HfJson *j=calloc(1,sizeof *j),*plan=calloc(1,sizeof *plan);RunnerConfig c={0};Instruction i={0};char p[4096];int64_t u=0,g=0;
 if(!j||!plan||!hf_private_read(argv[1],16384,&text,&n)||!hf_json_parse(j,text))return 3;
 #define LOAD(field) if(!hf_json_get(j,#field,c.field,sizeof c.field))return 4
 LOAD(state);LOAD(transport);LOAD(organisation);LOAD(run);LOAD(sandbox);LOAD(boot);
 #undef LOAD
 #define LOAD(field) if(!hf_json_get(j,#field,i.field,sizeof i.field))return 5
 LOAD(launch);LOAD(session);LOAD(attempt);LOAD(slot);
 #undef LOAD
 if(!hf_json_i64(j,hf_json_field(j,0,"uid"),&u)||!hf_json_i64(j,hf_json_field(j,0,"gid"),&g)||!hf_json_get(j,"plan",p,sizeof p)||!hf_private_read(p,65536,&raw,&n)||!hf_json_parse(plan,raw))return 6;
 i.uid=(uid_t)u;i.gid=(gid_t)g;strcpy(c.generation,"1");strcpy(i.attempt_generation,"1");i.body="{\"native_source_required\":true}";
 int ok=source_install(&c,&i,plan);if(ok)puts(i.source_config);free(text);free(raw);free(j);free(plan);return ok?0:1;
}
''')
        cleanup_c = root / 'cleanup.c'
        cleanup_c.write_text('#include ' + json.dumps(str(ROOT / 'core/native/src/hyperfide/control.c')) + r'''
int main(int argc,char **argv){
 if(argc!=3)return 2;
 char *text=NULL;size_t n=0;HfJson *j=calloc(1,sizeof *j);ControlConfig c={0};char slot[37],launch[37];sqlite3 *db=NULL;
 if(!j||!hf_private_read(argv[1],16384,&text,&n)||!hf_json_parse(j,text)||!hf_json_get(j,"state",c.state,sizeof c.state)||!hf_json_get(j,"slot",slot,sizeof slot)||!hf_json_get(j,"launch",launch,sizeof launch)||sqlite3_open(":memory:",&db)!=SQLITE_OK)return 3;
 if(sqlite3_exec(db,"CREATE TABLE credentials(command TEXT,name TEXT,digest TEXT,state TEXT,PRIMARY KEY(command,name))",NULL,NULL,NULL)!=SQLITE_OK)return 4;
 int result=source_credentials(db,&c,slot,launch,"11111111-1111-4111-8111-111111111111",!strcmp(argv[2],"revoke"));
 sqlite3_stmt *q=NULL;int count=0;if(sqlite3_prepare_v2(db,"SELECT count(*) FROM credentials WHERE state='REVOKED'",-1,&q,NULL)==SQLITE_OK&&sqlite3_step(q)==SQLITE_ROW)count=sqlite3_column_int(q,0);
 printf("{\"residue\":%d,\"revoked\":%d}\n",result,count);sqlite3_finalize(q);sqlite3_close(db);free(text);free(j);return 0;
}
''')
        binaries = {}
        for name, source in [('launcher', launcher_c), ('cleanup', cleanup_c)]:
            binary = root / name
            run('cc', '-O2', '-ffunction-sections', '-fdata-sections', '-I' + str(ROOT / 'core/native/src'), '-I' + str(ROOT / 'core/native/src/hyperfide'),
                str(source), str(ROOT / 'core/native/src/hyperfide/transport.c'), str(ROOT / 'core/native/src/sha256.c'), '-Wl,--gc-sections', '-o', str(binary), '-lsqlite3', '-lcrypto', '-lcurl', '-lm', '-lpthread')
            binaries[name] = str(binary)
        retained_key = state / ('source-key-' + ids['launch'] + '.pem')
        public = run(binaries['launcher'], 'keygen', str(retained_key)).stdout
        assert public == run(binaries['launcher'], 'public', str(retained_key)).stdout
        first = run(binaries['launcher'], str(fixture))
        client_path = Path(first.stdout.decode().strip())
        client = json.loads(client_path.read_text())
        assert client['assignment'] == body
        assert client['transport']['credential_id'] == ids['credential']
        assert client['transport']['endpoint'] == 'https://source.example.test/api/v1/source-control'
        files = [Path(client['transport']['key_file']), Path(client['transport']['ca_file']), client_path]
        for item in files:
            stat = item.stat()
            assert stat.st_uid == uid and stat.st_gid == gid and stat.st_mode & 0o777 == 0o600
        assert files[0].read_bytes() == retained_key.read_bytes()
        assert (workspace / '.neron').read_bytes() == original
        assert run('/bin/cat', str(client_path), user=uid, group=gid).returncode == 0
        assert run('/bin/cat', str(retained_key), user=uid, group=gid, ok=False).returncode != 0
        assert run(binaries['launcher'], str(fixture)).stdout == first.stdout
        assert public == run(binaries['launcher'], 'public', str(retained_key)).stdout
        victim = root / 'victim'
        victim.write_bytes(b'preserve outside content')
        key_bytes = files[0].read_bytes()
        files[0].unlink()
        files[0].symlink_to(victim)
        assert run(binaries['launcher'], str(fixture), ok=False).returncode != 0
        assert victim.read_bytes() == b'preserve outside content'
        files[0].unlink()
        files[0].write_bytes(key_bytes)
        files[0].chmod(0o600)
        os.chown(files[0], uid, gid)
        changed = json.loads(json.dumps(enrollment))
        changed['native_source']['assignment']['workspace_id'] = str(uuid.uuid4())
        write_json(enrollment_path, changed)
        assert run(binaries['launcher'], str(fixture), ok=False).returncode != 0
        write_json(enrollment_path, enrollment)
        assert run(binaries['launcher'], str(fixture)).returncode == 0
        directory = client_path.parent
        moved = directory.with_name(directory.name + '-saved')
        directory.rename(moved)
        directory.symlink_to(victim.parent, target_is_directory=True)
        refused = json.loads(run(binaries['cleanup'], str(fixture), 'revoke').stdout)
        assert refused['residue'] == -1 and victim.read_bytes() == b'preserve outside content'
        directory.unlink()
        moved.rename(directory)
        assert json.loads(run(binaries['cleanup'], str(fixture), 'inspect').stdout)['residue'] == 3
        removed = json.loads(run(binaries['cleanup'], str(fixture), 'revoke').stdout)
        assert removed == {'residue': 0, 'revoked': 3}
        assert all(not item.exists() for item in files)
        assert json.loads(run(binaries['cleanup'], str(fixture), 'inspect').stdout)['residue'] == 0
        material = state / ('source-material-' + ids['launch'] + '.json')
        material.unlink()
        files[1].symlink_to(victim)
        assert run(binaries['launcher'], str(fixture), ok=False).returncode != 0
        assert files[0].exists() and material.exists()
        assert victim.read_bytes() == b'preserve outside content'
        partial = json.loads(run(binaries['cleanup'], str(fixture), 'revoke').stdout)
        assert partial['residue'] == 0
        assert all(not item.exists() and not item.is_symlink() for item in files)
        assert victim.read_bytes() == b'preserve outside content'
        assert retained_key.exists() and retained_key.stat().st_mode & 0o777 == 0o600
        assert public == run(binaries['launcher'], 'public', str(retained_key)).stdout
        receipt = {'schema_version': 1, 'status': 'PASS', 'scope': 'native C handoff filesystem and credential cleanup boundary with declared wire inputs',
                   'checks': ['worker-owned private transport files', 'bootstrap descriptor preserved', 'stable retained enrollment key across replay',
                              'worker cannot read retained root key', 'no-follow file and directory refusal', 'mismatched assignment refused',
                              'credential cleanup recorded and replayable', 'partial installation journaled before credentials and cleaned'], 'network_delegation': 'tested separately'}
        (OUTPUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt))


if __name__ == '__main__':
    main()
