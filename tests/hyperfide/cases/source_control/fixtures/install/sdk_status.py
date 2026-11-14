#!/usr/bin/env python3
"""Keep the real signed READY producer alive for the SDK transport consumer.

The existing component harness supplies declared initial authority metadata and
an isolated provider HTTP boundary; native interruption, recovery, collection,
TLS, authentication and the status action all execute production code.
"""
import importlib.util
import json
from pathlib import Path
import secrets
import sys

ROOT = Path(__file__).resolve().parents[6]
case = ROOT / 'tests/hyperfide/cases/source_control/fleet_install_interrupted.py'
spec = importlib.util.spec_from_file_location('sdk_install_recovery', case)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
OriginalStack = base.stackmod.SubmissionStack
original_load = base.stackmod.load


def load_install_fixture(name, relative):
    module = original_load(name, relative)
    if relative == 'tests/hyperfide/cases/tasks/5_1.py':
        # Use the fixture's supported explicit-grant input. The full component
        # registry has more actions than a single credential may hold.
        components = ('14.1', '3.1', '3.2', '5.1', '5.2', '5.3', '5.4', '15.2',
                      'fleet-install', 'fleet-install-delivery', '12.4',
                      '12.4-executor', '10.3', '1.1', '8.2', '8.3', '16.1', '16.2')
        grants = sorted({action for component in components
                         for action in json.loads((ROOT / 'core/control-plane/components' / (component + '.json')).read_text())['actions']})
        assert 0 < len(grants) <= 256
        Scheduler = module.SchedulerFixture

        class InstallScheduler(Scheduler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, credential_actions=grants, **kwargs)

            def start(self):
                # Rebind the trusted fixture input before each service role
                # restart; startup must see the same run and explicit grants
                # in both the bootstrap document and the principal store.
                config = json.loads(self.identity_config.read_text())
                provisioners = [record for record in config['principals']
                                if record['credential_id'] == self.ids['provisioner']]
                assert len(provisioners) == 1
                provisioner = provisioners[0]
                provisioner.update(run_id=self.ids['run'], allowed_actions=grants)
                stored = self.sql(
                    "UPDATE hyperfide.identity_principals SET run_id=$2,allowed_actions=$3 "
                    "WHERE credential_id=$1 AND organisation_id=$4 AND role='PROVISIONER' AND state='ACTIVE' "
                    "RETURNING run_id,allowed_actions",
                    [self.ids['provisioner'], self.ids['run'], grants, self.ids['organisation']],
                )
                assert stored == [{'run_id': self.ids['run'], 'allowed_actions': grants}], stored
                self.identity_config.write_text(json.dumps(config))
                super().start()

            def bootstrap_runner(self, actions=None):
                return super().bootstrap_runner(actions=grants if actions is None else actions)

            def delegate_principal(self, name, session_id, allowed_actions=None):
                return super().delegate_principal(name, session_id, allowed_actions=grants if allowed_actions is None else allowed_actions)

        module.SchedulerFixture = InstallScheduler
    return module


class SdkStatusStack(OriginalStack):
    def setup(self, fixture):
        super().setup(fixture)
        fixture.env.update({
            'HF_SOURCE_S3_ENDPOINT': self.store.endpoint,
            'HF_SOURCE_S3_REGION': self.objects.REGION,
            'HF_SOURCE_S3_BUCKET': self.objects.BUCKET,
            'HF_SOURCE_S3_ACCESS_KEY_ID': self.objects.KEY,
            'HF_SOURCE_S3_SECRET_ACCESS_KEY': self.objects.SECRET,
            'HF_SOURCE_S3_SESSION_TOKEN': self.objects.TOKEN,
            'HF_SOURCE_ALLOW_LOOPBACK_HTTP': '1',
            'HF_SOURCE_CURSOR_KEY': secrets.token_urlsafe(32),
            'HF_SOURCE_CACHE_BYTES': '16777216',
            'HF_SOURCE_CACHE_ENTRIES': '1024',
            'HF_SOURCE_MAX_FILE_BYTES': '8388608',
            'HF_SOURCE_MATERIALIZED_BYTES': '67108864',
            'HF_SOURCE_DIRTY_BYTES': '16777216',
        })

    def close(self):
        try:
            fixture = getattr(self, 'fixture', None)
            if fixture and not getattr(self, '_sdk_status_started', False):
                self._sdk_status_started = True
                rows = fixture.sql("SELECT operation_id::text,receipt_digest FROM hyperfide.fleet_environment_installs WHERE state='READY'")
                if rows:
                    assert len(rows) == 1, rows
                    operation = rows[0]['operation_id']
                    status, response = fixture.invoke('fleet.install.status', {'operation_id': operation}, component='fleet-install', key='runner')
                    assert status == 200 and response['ok'] is True, response
                    assert response['result']['state'] == 'READY'
                    assert response['result']['receipt_digest'] == rows[0]['receipt_digest']
                    previous = fixture.sql('SELECT predecessor_install_operation_id::text FROM hyperfide.fleet_install_recoveries WHERE operation_id=$1', [operation])
                    assert len(previous) == 1
                    print('SDK_INSTALL_READY ' + json.dumps({
                        'origin': fixture.origin, 'ca_file': str(fixture.ca),
                        'run_id': fixture.ids['run'], 'operation_id': operation,
                        'predecessor_operation_id': previous[0]['predecessor_install_operation_id'],
                        'runner': {'credential_id': fixture.ids['runner'], 'key_file': str(fixture.keys['runner']['path'])},
                        'operator': {'credential_id': fixture.ids['operator'], 'key_file': str(fixture.keys['operator']['path'])},
                        'expected': response['result'],
                    }), flush=True)
                    assert sys.stdin.readline().strip() == 'close', 'SDK must release its actual producer'
        finally:
            super().close()


if __name__ == '__main__':
    base.stackmod.load = load_install_fixture
    base.stackmod.SubmissionStack = SdkStatusStack
    native = ROOT / 'build/hyperfide-native'
    sys.argv = [str(case), '--native-path', str(native), '--native-digest', base.sha(native.read_bytes())]
    raise SystemExit(base.main())
