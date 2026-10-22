#!/usr/bin/env python3
"""hyperfide-v21 3.3: blocked is the waiting state (migration 0711, D4).

Applies every release migration to an owned throwaway PostgreSQL cluster
(pattern of v21/3_1.py), grants the runtime role as deploy/hyperfide/grants.sql
does, and drives, as that role:
  - the transitions: a blocking Ask from a RUNNING task's attempt blocks it with
    tasks.blocked_ask; a proceed-and-flag Ask does not; answering moves the task
    to its next waiting blocking Ask (an expired one still waits), and the last
    answer returns it to RUNNING;
  - the guards that keep the reference honest;
  - dependant ineligibility through the real scheduler (requireNoAskWait);
  - stop preservation through the real 24.3 stop component (RUN STOP keeps the
    wait and its Ask, CANCEL releases it), and an answer after a stop leaves the
    revoked task held, not RUNNING.
Component scope only: the operator invocation is constructed in-process.
"""
import importlib.util, json, os, pathlib, signal, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / "services/hyperfide"
RUNTIME = "hf_runtime"
ASSERTIONS = [
    "migration.applied",
    "block.enters-blocked-with-ask",
    "block.proceed-and-flag-does-not",
    "block.second-ask-keeps-reference",
    "block.not-running-unaffected",
    "refuse.release-while-waiting",
    "refuse.running-with-reference",
    "refuse.reference-foreign-ask",
    "refuse.task-created-waiting",
    "answer.moves-to-next-waiting",
    "answer.expired-blocking-still-waits",
    "answer.returns-to-running",
    "dependant.ineligible-while-blocked",
    "dependant.eligible-after-answer",
    "stop.preserves-wait",
    "stop.blocks-other-tasks",
    "stop.answer-keeps-hold",
    "cancel.releases-wait",
]
RESULTS = {}


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(name, ok, detail=None):
    RESULTS[name] = bool(ok)
    if not ok:
        print("assertion failed: %s %s" % (name, json.dumps(detail, default=str)[:2000] if detail is not None else ""), file=sys.stderr, flush=True)


def u():
    return str(uuid.uuid4())


def q(value):
    return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"


def ensure_build(base):
    # The case exercises the current source, so it builds dist rather than trusting a stale one.
    p = subprocess.run(["npm", "--prefix", str(SERVICE), "run", "build"], cwd=ROOT, env=base, capture_output=True, text=True, timeout=900)
    if p.returncode:
        raise AssertionError("service build failed: " + (p.stderr + p.stdout)[-1500:])


class Db:
    def __init__(self, cluster, t295):
        self.cluster, self.t295 = cluster, t295

    def rows(self, statement, user=RUNTIME):
        return json.loads(self.cluster.sql("SELECT coalesce(json_agg(r),'[]') FROM (" + statement + ") r", user=user))

    def run(self, statement, user=RUNTIME):
        return self.cluster.sql(statement, user=user)

    def refused(self, statement, needle, user=RUNTIME):
        p = self.cluster.psql(user, self.t295.DATABASE, "-Atc", statement)
        return p.returncode != 0 and needle in p.stderr, p.stderr.strip()[-400:]

    def task(self, task_id):
        return self.rows("SELECT state,blocked_ask,state_version FROM hyperfide.tasks WHERE id=%s" % q(task_id))[0]


D = "'sha256:'||repeat('a',64)"


def seed_org(db, o):
    db.run(";".join([
        "BEGIN",
        f"INSERT INTO hyperfide.organisations(id,name) VALUES('{o['org']}','blocked-probe')",
        f"INSERT INTO hyperfide.projects(organisation_id,id,name) VALUES('{o['org']}','{o['project']}','fixture')",
        f"INSERT INTO hyperfide.spec_revisions(organisation_id,id,project_id,source_digest,source_content,document,schema_version) VALUES('{o['org']}','{o['spec']}','{o['project']}','sha256:'||encode(sha256(convert_to('fixture','UTF8')),'hex'),'fixture','{{}}',1)",
        f"INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region) VALUES('{o['org']}','{o['pool']}','railway','fixture','fixture','fixture')",
        f"INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,observed_state) VALUES('{o['org']}','{o['sandbox']}','{o['pool']}','RUNNING')",
        "COMMIT",
    ]), user=db.t295.SUPERUSER)


def seed_run(db, o, run_id, tasks):
    """tasks: list of (task_key, wave, running). Returns {key: (task_id, attempt_id or None)}."""
    package = u()
    out, sql = {}, ["BEGIN",
        f"INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch,state) VALUES('{o['org']}','{run_id}','{o['project']}','{o['spec']}',{D},'{o['epoch']}','RUNNING')",
        f"INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES('{o['org']}','{run_id}','{package}','package',1)"]
    for key, wave, running in tasks:
        task, attempt, slot = u(), u(), u()
        sql.append(f"INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES('{o['org']}','{run_id}','{task}','{key}','{package}','{o['spec']}',{D},'{{}}',{wave})")
        if running:
            sql += [
                f"INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES('{o['org']}','{slot}','{o['sandbox']}','w-{slot[:8]}',1,'AGENT')",
                f"INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES('{o['org']}','{run_id}','{attempt}','{task}',1,'{o['epoch']}',{D},'RUNNING','CURRENT','{o['sandbox']}','{slot}',1,clock_timestamp()+interval '30 minutes')",
                f"UPDATE hyperfide.tasks SET generation=1,current_attempt_id='{attempt}',state='RUNNING',state_version=state_version+1 WHERE organisation_id='{o['org']}' AND run_id='{run_id}' AND id='{task}'",
            ]
        out[key] = (task, attempt if running else None)
    sql.append("COMMIT")
    db.run(";".join(sql), user=db.t295.SUPERUSER)
    return out


def raise_ask(db, o, run_id, task, attempt, policy="block", kind=None, deadline="NULL"):
    ask = u()
    kind = kind or ("variable" if policy == "block" else "decision")
    options, recommended = ('["a","b"]', "'a'") if policy != "block" or deadline != "NULL" else ("[]", "NULL")
    if policy != "block" and deadline == "NULL":
        deadline = "clock_timestamp()+interval '1 day'"
    db.run("INSERT INTO hyperfide.asks(organisation_id,id,run_id,kind,title,options,recommended,deadline,default_policy,task,attempt,raised_by) "
           "VALUES(%s,%s,%s,%s,'Need it',%s::jsonb,%s,%s,%s,%s,%s,%s)"
           % (q(o["org"]), q(ask), q(run_id), q(kind), q(options), recommended, deadline, q(policy), q(task), q(attempt), q(o["worker"])))
    return ask


def answer(db, o, ask, value="b"):
    db.run("UPDATE hyperfide.asks SET state='ANSWERED',answer=%s,answered_by=%s,answered_at=clock_timestamp(),state_version=state_version+1 WHERE id=%s"
           % (q(value), q(o["operator"]), q(ask)))


PROBE = r"""
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {createComponent} from './services/hyperfide/dist/recovery/stop.js';
import {createComponent as createScheduler} from './services/hyperfide/dist/scheduler/claim.js';
import {requireNoAskWait} from './services/hyperfide/dist/scheduler/resources.js';
import {authenticatedInvocation} from './services/hyperfide/dist/transport/protocol.js';
import {randomUUID} from 'node:crypto';
const ids=JSON.parse(process.env.HF_BLOCKED_IDS);
const controller=new AbortController();
const r=createResourceContainer({role:'control',env:process.env,signal:controller.signal});
const tx=body=>r.gateway.withPrimaryTransaction({timeoutMs:30000,maxRetries:3},body);
const out={};
try{
 if(ids.phase==='dependant'){
  try{await tx(t=>requireNoAskWait(t,{organisation_id:ids.org,run_id:ids.run},ids.task,ids.wave));out.code=null;}
  catch(e){out.code=e.code??String(e);out.message=e.message;}
 }else{
  const scheduler=createScheduler({});
  const providers={'4.2':{'storage.transactions.v1':r.gateway},'5.1':scheduler.capabilities};
  const dependencies={require:(id,name,guard)=>{const v=providers[id]?.[name];if(!guard(v))throw Error('missing '+id+'/'+name);return v;}};
  const env={...process.env,HYPERFIDE_STOP_DRIVER_INTERVAL_MS:'0'};
  const startup={role:'control',signal:controller.signal,env,resources:r,dependencies};
  const invocation=authenticatedInvocation({principal:{credential_id:randomUUID(),organisation_id:ids.org,run_id:ids.run,actor_id:randomUUID(),role:'OPERATOR',deployment_epoch:ids.epoch,allowed_actions:['recovery.stop.request'],expires_at:new Date(Date.now()+3600000).toISOString()},operation:{},payload:{},signal:controller.signal,guard:async()=>{},identityGuard:async()=>{},continuationGuard:async()=>{}});
  const stop=createComponent(startup);
  try{
   const result=await stop.actions['recovery.stop.request']({scope:{organisation_id:ids.org,run_id:ids.run,authority_epoch:ids.epoch},operation_id:randomUUID(),scope_kind:'RUN',scope_id:ids.run,mode:ids.mode,reason:'blocked case 3.3'},{...startup,invocation});
   out.result=result;
  }finally{await stop.close?.();}
 }
}finally{controller.abort();await r.close();}
console.log(JSON.stringify(out));
"""


def probe(t295, base, cluster, ids):
    output = t295.run(["node", "--input-type=module", "-e", PROBE],
                      {**base, "DATABASE_URL": cluster.url(RUNTIME), "HF_BLOCKED_IDS": json.dumps(ids)}, timeout=300)
    return json.loads(output.strip().splitlines()[-1])


def scenario(db, o, t295, base, cluster):
    applied = db.rows("SELECT version,name FROM hyperfide.schema_migrations WHERE version=711", user=t295.SUPERUSER)
    column = db.rows("SELECT column_name FROM information_schema.columns WHERE table_schema='hyperfide' AND table_name='tasks' AND column_name='blocked_ask'")
    check("migration.applied", applied == [{"version": 711, "name": "0711-blocked-tasks"}] and len(column) == 1, [applied, column])

    run1 = u()
    t = seed_run(db, o, run1, [("1.1", 1, True), ("1.2", 1, False), ("2.1", 2, False)])
    task, attempt = t["1.1"]

    flag = raise_ask(db, o, run1, task, attempt, policy="proceed-and-flag")
    check("block.proceed-and-flag-does-not", db.task(task)["state"] == "RUNNING", db.task(task))
    first = raise_ask(db, o, run1, task, attempt)
    after = db.task(task)
    check("block.enters-blocked-with-ask", after["state"] == "BLOCKED" and after["blocked_ask"] == first, after)
    second = raise_ask(db, o, run1, task, attempt, kind="permission", deadline="clock_timestamp()+interval '1 second'")
    check("block.second-ask-keeps-reference", db.task(task)["blocked_ask"] == first, db.task(task))
    idle = t["1.2"][0]
    raise_ask(db, o, run1, idle, None)
    check("block.not-running-unaffected", db.task(idle) == {"state": "PENDING", "blocked_ask": None, "state_version": 1}, db.task(idle))

    ok, err = db.refused("UPDATE hyperfide.tasks SET state='RUNNING',blocked_ask=NULL,state_version=state_version+1 WHERE id=%s" % q(task), "waits on unanswered ask")
    check("refuse.release-while-waiting", ok, err)
    ok, err = db.refused("UPDATE hyperfide.tasks SET state='RUNNING',state_version=state_version+1 WHERE id=%s" % q(task), "tasks_blocked_ask_state")
    check("refuse.running-with-reference", ok, err)
    # An Ask raised by another task cannot be borrowed as a wait reference.
    ok, err = db.refused("UPDATE hyperfide.tasks SET state='BLOCKED',blocked_ask=%s,state_version=state_version+1 WHERE id=%s" % (q(first), q(idle)), "does not hold task")
    check("refuse.reference-foreign-ask", ok, err)
    ok, err = db.refused("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave,state,blocked_ask) "
                         "SELECT organisation_id,run_id,gen_random_uuid(),'9.9',feature_package_id,spec_revision_id,criteria_digest,definition,1,'BLOCKED',%s FROM hyperfide.tasks WHERE id=%s"
                         % (q(first), q(task)), "never created waiting")
    check("refuse.task-created-waiting", ok, err)

    # Dependants: a later-wave task is held while its predecessor waits on an Ask.
    dep = probe(t295, base, cluster, {"phase": "dependant", "org": o["org"], "run": run1, "task": t["2.1"][0], "wave": 2})
    check("dependant.ineligible-while-blocked", dep.get("code") == "PREDECESSOR_WAITING_ON_ASK" and first in dep.get("message", ""), dep)

    answer(db, o, first)
    moved = db.task(task)
    check("answer.moves-to-next-waiting", moved["state"] == "BLOCKED" and moved["blocked_ask"] == second, moved)
    for _ in range(50):
        if db.rows("SELECT 1 AS due FROM hyperfide.asks WHERE id=%s AND clock_timestamp()>=deadline" % q(second)):
            break
        subprocess.run(["sleep", "0.1"])
    db.run("UPDATE hyperfide.asks SET state='EXPIRED',expired_at=clock_timestamp(),state_version=state_version+1 WHERE id=%s" % q(second))
    check("answer.expired-blocking-still-waits", db.task(task)["state"] == "BLOCKED" and db.task(task)["blocked_ask"] == second, db.task(task))
    answer(db, o, second, "approve")
    back = db.task(task)
    check("answer.returns-to-running", back["state"] == "RUNNING" and back["blocked_ask"] is None, back)
    dep = probe(t295, base, cluster, {"phase": "dependant", "org": o["org"], "run": run1, "task": t["2.1"][0], "wave": 2})
    check("dependant.eligible-after-answer", dep.get("code") is None, dep)
    del flag

    # Stop: the waiting task and its Ask survive a RUN STOP; the running one is held.
    run2 = u()
    s = seed_run(db, o, run2, [("1.1", 1, True), ("1.2", 1, True)])
    waiting, w_attempt = s["1.1"]
    ask = raise_ask(db, o, run2, waiting, w_attempt)
    before = db.task(waiting)
    stopped = probe(t295, base, cluster, {"phase": "stop", "mode": "STOP", "org": o["org"], "run": run2, "epoch": o["epoch"]})
    held = db.task(waiting)
    preserved = stopped.get("result", {}).get("ask_waits_preserved")
    check("stop.preserves-wait", held == before and preserved == [{"task_id": waiting, "ask_id": ask}], [before, held, stopped])
    check("stop.blocks-other-tasks", db.task(s["1.2"][0])["state"] == "BLOCKED" and db.task(s["1.2"][0])["blocked_ask"] is None, db.task(s["1.2"][0]))
    answer(db, o, ask)
    late = db.task(waiting)
    check("stop.answer-keeps-hold", late["state"] == "BLOCKED" and late["blocked_ask"] is None, late)

    # Cancel ends the task: the wait is released with it.
    run3 = u()
    c = seed_run(db, o, run3, [("1.1", 1, True)])
    ctask, cattempt = c["1.1"]
    cask = raise_ask(db, o, run3, ctask, cattempt)
    cancelled = probe(t295, base, cluster, {"phase": "stop", "mode": "CANCEL", "org": o["org"], "run": run3, "epoch": o["epoch"]})
    end = db.task(ctask)
    still = db.rows("SELECT state FROM hyperfide.asks WHERE id=%s" % q(cask))
    check("cancel.releases-wait", end["state"] == "CANCELLED" and end["blocked_ask"] is None and still == [{"state": "OPEN"}], [end, still, cancelled])


def main():
    configured = os.environ.get("HYPERFIDE_PG_BIN")
    servers = [pathlib.Path(configured)] if configured else sorted(
        (path for path in pathlib.Path("/usr/lib/postgresql").glob("*/bin") if path.parent.name.isdigit() and (path / "initdb").exists()),
        key=lambda path: int(path.parent.name))
    if not servers or not (servers[-1] / "initdb").exists():
        print("SKIP: no PostgreSQL server binaries (initdb); set HYPERFIDE_PG_BIN", flush=True)
        return 77
    if os.geteuid() != 0:
        print("SKIP: the owned cluster runs initdb through runuser postgres, which needs root", flush=True)
        return 77
    t295 = load("hf_case_29_5", "tests/hyperfide/cases/tasks/29_5.py")
    t295.postgres_bin = lambda: servers[-1]
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    base = os.environ.copy()
    # Only the owned cluster is reachable: never let an inherited database URL redirect a probe.
    for key in list(base):
        if key == "DATABASE_URL" or key.startswith("HYPERFIDE_") and key.endswith("_DATABASE_URL"):
            del base[key]
    removed, cluster = False, None
    try:
        ensure_build(base)
        cluster = t295.Cluster()
        cluster.sql("CREATE ROLE " + t295.OPERATOR + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS", database="postgres")
        cluster.sql("CREATE DATABASE " + t295.DATABASE + " OWNER " + t295.OPERATOR, database="postgres")
        for attempt in range(6):
            try:
                t295.node(t295.MIGRATE, {**base, "DATABASE_URL": cluster.url(t295.OPERATOR)})
                break
            except AssertionError as error:
                if attempt == 5 or "TX_TIMEOUT" not in str(error):
                    raise
        cluster.sql("CREATE ROLE " + RUNTIME + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT")
        t295.applied(cluster.grants(t295.OPERATOR, RUNTIME))
        names = ["org", "project", "spec", "pool", "sandbox", "epoch", "worker", "operator"]
        o = {name: u() for name in names}
        db = Db(cluster, t295)
        seed_org(db, o)
        scenario(db, o, t295, base, cluster)
    except Exception:
        traceback.print_exc(file=sys.stderr)
    finally:
        try:
            removed = cluster.close() if cluster else False
        except Exception as error:
            print("cleanup failed: " + str(error), file=sys.stderr)
    for name in ASSERTIONS:
        print(json.dumps({"type": "assertion", "id": name, "expected": True, "actual": RESULTS.get(name, False)}), flush=True)
    print(json.dumps({"type": "cleanup", "resources": [{"id": "postgres-cluster", "status": "deleted" if removed else "unknown", "observed_absent": removed}],
                      "complete": bool(removed)}), flush=True)
    return 0 if removed and all(RESULTS.get(name) for name in ASSERTIONS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
