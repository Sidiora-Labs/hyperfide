#!/usr/bin/env python3
"""Exercise metadata replay, real worker identity and collection on owned PostgreSQL."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from identity_fixture import IdentityFixture, sha, uid

fixture = ROOT / 'tests/hyperfide/support/native_source_fixture.py'
spec = importlib.util.spec_from_file_location('native_source_fixture', fixture)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main():
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'),
                               '--', sys.executable, str(Path(__file__).resolve())], cwd=ROOT).returncode
    actions = ['source.revisions.create', 'source.operations.read']
    f = IdentityFixture(extra_actions=actions)
    try:
        f.bootstrap_runner()
        i = f.ids
        i.update({key: uid() for key in ['metadata_package', 'metadata_task', 'metadata_attempt',
                                        'metadata_slot', 'metadata_worker']})
        f.sql("INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES($1,$2,$3,'metadata-replay',1)",
              [i['organisation'], i['run'], i['metadata_package']])
        f.sql("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,'metadata-replay',$4,$5,$6,'{}',1)",
              [i['organisation'], i['run'], i['metadata_task'], i['metadata_package'], i['spec'], sha(b'metadata-replay')])
        f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES($1,$2,$3,'metadata-replay',1,'AGENT')",
              [i['organisation'], i['metadata_slot'], i['sandbox']])
        f.sql("INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES($1,$2,$3,$4,1,$5,$6,'CURRENT',$7,$8,1,clock_timestamp()+interval '5 minutes')",
              [i['organisation'], i['run'], i['metadata_attempt'], i['metadata_task'], i['epoch'], sha(b'metadata-input'), i['sandbox'], i['metadata_slot']])
        f.sql("UPDATE hyperfide.tasks SET current_attempt_id=$3,generation=1,state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$4",
              [i['organisation'], i['run'], i['metadata_attempt'], i['metadata_task']])
        f.sql("INSERT INTO hyperfide.compute_leases(organisation_id,run_id,attempt_id,attempt_generation,authority_epoch,sandbox_boot_generation,expires_at) SELECT organisation_id,run_id,id,generation,authority_epoch,sandbox_boot_generation,lease_expires_at FROM hyperfide.attempts WHERE id=$1",
              [i['metadata_attempt']])
        f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,attempt_id) VALUES($1,$2,$3,'WORKER','fixture','fixture',$4,$5,$6,1,$7)",
              [i['organisation'], i['run'], i['metadata_worker'], uid(), i['metadata_slot'], i['sandbox'], i['metadata_attempt']])
        delegated = f.delegate_principal('metadata_credential', i['metadata_worker'], allowed_actions=actions)
        identity = {'ids': i, 'origin': f.origin, 'worker_key': str(f.keys['metadata_credential']['path']),
                    'runner_key': str(f.keys['runner']['path']), 'worker': delegated}
        return module.run_source_actor(ROOT / 'tests/hyperfide/support/source_metadata_actor.mjs',
                                       timeout=180, actor_env=dict(f.env, DATABASE_URL=f.url, SOURCE_METADATA_IDENTITY=json.dumps(identity)))
    finally:
        f.close()


if __name__ == '__main__':
    raise SystemExit(main())
