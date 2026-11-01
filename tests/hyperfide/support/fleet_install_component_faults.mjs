import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const faultNames = ['missing-code', 'removed-dependency', 'removed-config', 'stale-source-pin', 'stale-config-pin', 'path-escape'];
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function child(argv, slot, input, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const processChild = spawn('/usr/bin/setpriv', ['--reuid', String(slot.uid), '--regid', String(slot.gid), '--clear-groups', ...argv], {
      env: {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: slot.home, TMPDIR: slot.temporary, LANG: 'C.UTF-8'},
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    const chunks = {stdout: [], stderr: []};
    let size = 0, timeout = false;
    const kill = () => { try { process.kill(-processChild.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timeout = true; kill(); }, timeoutMs);
    for (const field of ['stdout', 'stderr']) processChild[field].on('data', bytes => {
      size += bytes.length;
      if (size > 1048576) kill(); else chunks[field].push(bytes);
    });
    processChild.once('error', error => { clearTimeout(timer); reject(error); });
    processChild.once('close', (exit_code, signal) => {
      clearTimeout(timer); kill();
      resolve({exit_code, signal, timeout, duration_ms: Date.now() - start,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        stdout_digest: sha(Buffer.concat(chunks.stdout)), stderr_digest: sha(Buffer.concat(chunks.stderr))});
    });
    processChild.stdin.on('error', () => {});
    processChild.stdin.end(input);
  });
}
async function assertFixtureRoot(root) {
  requireValue(typeof root === 'string' && path.isAbsolute(root) && path.resolve(root) === root && /^fleet-component-faults-[A-Za-z0-9_-]+$/.test(path.basename(root)) && ['/tmp', '/var/tmp'].includes(path.dirname(root)), 'Mutation requires an explicitly isolated /tmp or /var/tmp/fleet-component-faults-* environment_root');
  requireValue(await fs.realpath(root) === root, 'Fixture root must have canonical ancestry');
  const stat = await fs.lstat(root);
  requireValue(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'Fixture root must be root-owned and protected');
}
async function assertMutationPath(root, filename) {
  requireValue(path.isAbsolute(filename) && path.resolve(filename) === filename && filename.startsWith(root + '/'), 'Mutation target must remain beneath isolated component root');
  requireValue(await fs.realpath(filename) === filename, 'Mutation target must not traverse symlinks');
}
async function readProtectedInput(filename) {
  const absolute = path.resolve(filename);
  requireValue(await fs.realpath(absolute) === absolute, 'Input must not traverse symlinks');
  const handle = await fs.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    requireValue(before.isFile() && before.nlink === 1 && before.uid === 0 && (before.mode & 0o022) === 0 && before.size <= 4 * 1024 * 1024, 'Input must be a root-owned protected ordinary singlelink file');
    const bytes = await handle.readFile(), after = await handle.stat();
    requireValue(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'Input changed while reading');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await handle.close(); }
}
async function snapshot(filename) {
  const stat = await fs.lstat(filename);
  requireValue(stat.isFile() && stat.nlink === 1, 'Fault target must be a private ordinary file: ' + filename);
  return {filename, bytes: await fs.readFile(filename), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid};
}
async function restore(saved) {
  await fs.writeFile(saved.filename, saved.bytes);
  await fs.chown(saved.filename, saved.uid, saved.gid);
  await fs.chmod(saved.filename, saved.mode);
  requireValue(sha(await fs.readFile(saved.filename)) === sha(saved.bytes), 'Fault target restoration failed');
}
export async function runInstallComponentFaults({input, peerInput, runtimeRoot, cases = faultNames, nodePath = process.execPath}) {
  requireValue(process.getuid?.() === 0, 'Actual kernel UID transitions require root');
  requireValue(input?.kind === 'FLEET_MANIFEST_V1' && input.slot?.uid > 0 && input.slot?.gid > 0, 'Caller must supply production-derived readiness inputs');
  await assertFixtureRoot(input.environment_root);
  if (peerInput) { await assertFixtureRoot(peerInput.environment_root); requireValue(peerInput.environment_root === input.environment_root, 'Peer must share the explicitly isolated component root'); }
  const probe = path.join(path.resolve(runtimeRoot), 'preparation/fleet_readiness_probe.js');
  const measure = value => child([nodePath, probe], value.slot, JSON.stringify(value));
  const baseline = await measure(input);
  requireValue(baseline.exit_code === 0 && JSON.parse(baseline.stdout).status === 'READY', 'Healthy production probe prerequisite failed: ' + JSON.stringify(baseline));
  const observations = [];
  for (const fault of cases) {
    requireValue(faultNames.includes(fault) || fault === 'concurrent-cross-uid-writes', 'Unsupported fault: ' + fault);
    const changed = structuredClone(input);
    let saved, target;
    try {
      if (fault === 'missing-code' || fault === 'stale-source-pin') {
        requireValue(input.source_files.length > 0, fault + ' requires an installed source file');
        target = path.resolve(input.slot.source, input.source_files[0].path);
        requireValue(target.startsWith(input.slot.source + '/'), 'Source target escapes slot');
        await assertMutationPath(input.environment_root, target); saved = await snapshot(target);
        if (fault === 'missing-code') await fs.unlink(target);
        else changed.source_files[0].digest = sha(Buffer.concat([saved.bytes, Buffer.from('\nstale pin\n')]));
      } else if (fault === 'removed-dependency') {
        const {captureDependencyInventory} = await import(pathToFileURL(path.join(path.resolve(runtimeRoot), 'preparation/fleet_install_inventory.js')));
        const inventory = await captureDependencyInventory(input.slot.source);
        const entry = inventory.entries.find(row => row.kind === 'file');
        requireValue(entry, 'removed-dependency requires a real installed dependency file');
        target = path.join(input.slot.source, entry.path); await assertMutationPath(input.environment_root, target); saved = await snapshot(target); await fs.unlink(target);
      } else if (fault === 'removed-config' || fault === 'stale-config-pin') {
        const index = input.configurations.findIndex(row => row.kind === 'config-ref');
        requireValue(index !== -1, fault + ' requires an installed config-ref');
        target = input.configurations[index].target; await assertMutationPath(input.environment_root, target); saved = await snapshot(target);
        if (fault === 'removed-config') await fs.unlink(target);
        else changed.configurations[index].digest = sha(Buffer.concat([saved.bytes, Buffer.from('\nstale pin\n')]));
      } else if (fault === 'path-escape') {
        requireValue(input.source_files.length > 0, 'path-escape requires source inventory');
        changed.source_files[0].path = '../' + path.basename(input.slot.home) + '/escape-' + randomUUID();
      } else {
        requireValue(peerInput?.slot?.uid > 0 && peerInput.slot.uid !== input.slot.uid, 'Concurrent case requires two distinct real worker UIDs');
        const peerBaseline = await measure(peerInput);
        requireValue(peerBaseline.exit_code === 0 && JSON.parse(peerBaseline.stdout).status === 'READY', 'Peer production probe prerequisite failed');
        const slots = [input.slot, peerInput.slot];
        const targets = slots.map(slot => path.join(slot.build, 'cross-uid-' + randomUUID()));
        for (const [index, slot] of slots.entries()) {
          await assertMutationPath(input.environment_root, slot.build);
          const stat = await fs.lstat(slot.build);
          requireValue(stat.isDirectory() && stat.uid === slot.uid && stat.gid === slot.gid && (stat.mode & 0o077) === 0, 'Cross UID targets require actual private worker build directories');
          requireValue(targets[index].startsWith(input.environment_root + '/'), 'Cross UID target escapes isolated root');
        }
        const code = "const fs=require('node:fs');try{fs.writeFileSync(process.argv[1],'unauthorized',{flag:'wx'});console.log(JSON.stringify({uid:process.getuid(),write:'succeeded'}));process.exitCode=1}catch(e){console.log(JSON.stringify({uid:process.getuid(),errno:e.code,syscall:e.syscall}));process.exitCode=e.code==='EACCES'?0:2}";
        let runs;
        try {
          runs = await Promise.all(slots.map((slot, index) => child([nodePath, '-e', code, targets[1-index]], slot, '')));
          for (const run of runs) requireValue(run.exit_code === 0 && JSON.parse(run.stdout).errno === 'EACCES', 'Cross UID write was not denied: ' + JSON.stringify(run));
          observations.push({fault, stage: 'kernel-worker-isolation', processes: runs, target_paths: targets});
        } finally { for (const file of targets) await fs.rm(file, {force: true}); }
        continue;
      }
      const result = await measure(changed);
      requireValue(!result.timeout && result.exit_code !== 0 && result.stderr.trim() === '{"code":"FLEET_RUNTIME_NOT_READY"}', 'Expected production readiness refusal: ' + JSON.stringify(result));
      const current = target ? await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : undefined;
      observations.push({fault, stage: 'manifest-backed-runtime-measurement', result, target_path: target,
        before_digest: saved && sha(saved.bytes), observed_digest: current === null ? null : current && sha(current),
        changed_input_digest: sha(JSON.stringify(changed))});
    } finally { if (saved) await restore(saved); }
    const recovered = await measure(input);
    requireValue(recovered.exit_code === 0 && JSON.parse(recovered.stdout).status === 'READY', 'Production probe did not recover after restoration');
  }
  return {schema_version: 1, kind: 'fleet-install-component-fault-observations', scope: 'local-components-only',
    qualification: 'does-not-qualify-live-fleet-case', runtime_probe: probe, runtime_probe_digest: sha(await fs.readFile(probe)),
    input_digest: sha(JSON.stringify(input)), baseline, observations,
    unsupported: [{fault: 'interruption', reason: 'Requires an authorized in-flight native preparation job; a readiness input cannot exercise installer interruption'}]};
}
export async function runControlledComponentFixture(runtimeRoot) {
  requireValue(process.getuid?.() === 0, 'Controlled UID fixture requires root');
  const uids = [61821, 61822];
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const status = await fs.readFile('/proc/' + entry + '/status', 'utf8').catch(error => { if (['ENOENT', 'ESRCH'].includes(error.code)) return ''; throw error; });
    requireValue(!uids.includes(Number(/^Uid:\s+(\d+)/m.exec(status)?.[1])), 'Fixture UID already active');
  }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-component-faults-'));
  try {
    await fs.chmod(parent, 0o755);
    const runtime = path.join(parent, 'runtime');
    await fs.mkdir(runtime);
    const modules = ['preparation/fleet_readiness_probe.js', 'preparation/fleet_readiness_contract.js', 'preparation/fleet_install_inventory.js', 'preparation/fleet_toolchains.js', 'preparation/fleet_configurations.js', 'preparation/fleet_client.js', 'transport/protocol.js', 'policy/programme.js', 'contracts/fleet/index.mjs'];
    for (const name of modules) {
      const destination = path.join(runtime, name);
      await fs.mkdir(path.dirname(destination), {recursive: true, mode: 0o755});
      await fs.copyFile(path.join(runtimeRoot, name), destination);
      await fs.chmod(destination, 0o444);
    }
    await fs.writeFile(path.join(runtime, 'package.json'), '{"type":"module"}');
    const nodePath = path.join(runtime, 'node');
    await fs.copyFile(process.execPath, nodePath); await fs.chmod(nodePath, 0o555);
    const interfaces = '[interface.component]\nkind = "function"\npath = "code.js"\nline = 1\nsignature = "component()"\ncallers = []\nstatus = "active"\ncontract = "Local component measurement"\nnotes = ""\n';
    const interfacePath = path.join(parent, 'interfaces.kvx');
    await fs.writeFile(interfacePath, interfaces, {mode: 0o444});
    const inputs = [];
    const {captureDependencyInventory} = await import(pathToFileURL(path.join(runtime, 'preparation/fleet_install_inventory.js')));
    for (const uid of uids) {
      const worker = path.join(parent, 'worker-' + uid); await fs.mkdir(worker, {mode: 0o755});
      const slot = {uid, gid: uid};
      for (const name of ['source', 'home', 'temporary', 'build']) {
        slot[name] = path.join(worker, name); await fs.mkdir(slot[name], {mode: 0o700}); await fs.chown(slot[name], uid, uid);
      }
      for (const [name, bytes] of [['code.js', 'export const component = 1;\n'], ['.neron', 'local-component-config\n'], ['node_modules/component/index.js', 'module.exports = 1;\n']]) {
        const target = path.join(slot.source, name); await fs.mkdir(path.dirname(target), {recursive: true});
        await fs.writeFile(target, bytes, {mode: 0o600}); await fs.chown(target, uid, uid);
      }
      const config = path.join(slot.home, 'component.conf'); await fs.writeFile(config, 'installed-config\n', {mode: 0o600}); await fs.chown(config, uid, uid);
      const bytes = await fs.readFile(path.join(slot.source, 'code.js'));
      const revision = 'git:' + '0'.repeat(40);
      inputs.push({schema_version: 1, kind: 'FLEET_MANIFEST_V1', environment_root: parent, slot,
        source_revision: revision, source_files: [{path: 'code.js', size: bytes.length, mode: '100644', digest: sha(bytes)}],
        source_config_digest: sha(await fs.readFile(path.join(slot.source, '.neron'))),
        dependency_inventory_digest: (await captureDependencyInventory(slot.source)).digest,
        toolchains: [], toolchain_manifest: {}, probes: [],
        configurations: [{kind: 'config-ref', target: config, private: true, mode: '0600', digest: sha(await fs.readFile(config))}],
        interfaces: {target: interfacePath, digest: sha(interfaces), source_revision: revision, selected_ids: ['interface.component'], max_bytes: 65536, max_blocks: 10}});
    }
    const report = await runInstallComponentFaults({input: inputs[0], peerInput: inputs[1], runtimeRoot: runtime, nodePath, cases: [...faultNames, 'concurrent-cross-uid-writes']});
    return {...report, fixture: {kind: 'controlled-local-readiness-input', uid_values: uids, toolchain_probes: 0, provider_mutations: 0, temporary_tree_removed_on_exit: true}};
  } finally { await fs.rm(parent, {recursive: true, force: true}); }
}
async function main() {
  if (process.argv[2] === '--fixture' && process.argv.length === 4) {
    process.stdout.write(JSON.stringify(await runControlledComponentFixture(path.resolve(process.argv[3]))) + '\n'); return;
  }
  const options = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    requireValue(['--input', '--peer-input', '--runtime', '--cases', '--node'].includes(key) && process.argv[i+1] && !options.has(key), 'Use --input FILE --runtime EMITTED_DIST [--peer-input FILE] [--cases NAME,...] [--node PATH]');
    options.set(key, process.argv[i+1]);
  }
  requireValue(options.has('--input') && options.has('--runtime'), 'Use --input FILE --runtime EMITTED_DIST; worker UIDs must be able to traverse runtime and node paths');
  const read = readProtectedInput;
  const result = await runInstallComponentFaults({input: await read(options.get('--input')), peerInput: options.has('--peer-input') ? await read(options.get('--peer-input')) : undefined,
    runtimeRoot: options.get('--runtime'), cases: options.has('--cases') ? options.get('--cases').split(',') : undefined, nodePath: options.get('--node')});
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
