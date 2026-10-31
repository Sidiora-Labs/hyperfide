#!/usr/bin/env python3
"""hyperfide-v21 3.1: the asks table (migration 0709-asks.sql).

Applies every release migration to an owned throwaway PostgreSQL cluster
(pattern of tasks/29_5.py and v21/2_17.py), grants the runtime role exactly as
deploy/hyperfide/grants.sql does, and drives hyperfide.asks as that runtime
role: one Ask of each workflow kind, an answer, a proceed-and-flag expiry that
takes the recommended default, a blocking expiry answered late, and the
refusals that keep the head and its append-only history honest.
"""
import importlib.util, json, os, pathlib, signal, subprocess, sys, time, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / "core/control-plane"
RUNTIME = "hf_runtime"
KINDS = ["secret", "variable", "permission", "decision", "question"]
ASSERTIONS = [
    "migration.applied",
    "raise.each-kind-open",
    "raise.event-per-kind",
    "raise.references-kept",
    "answer.head",
    "answer.event",
    "expire.default-taken-head",
    "expire.default-taken-event",
    "expire.blocking-stays-unanswered",
    "expire.blocking-answered-late",
    "history.matches-head",
    "refuse.early-expiry",
    "refuse.reanswer",
    "refuse.answer-after-default",
    "refuse.stale-state-version",
    "refuse.immutable-field",
    "refuse.delete-head",
    "refuse.history-mutation",
    "refuse.forged-event",
    "refuse.unknown-kind",
    "refuse.silent-default-kind",
    "refuse.recommended-outside-options",
    "refuse.secret-value",
    "refuse.unknown-task",
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
    stamp = subprocess.run(["node", "deploy/hyperfide/dist-stamp.mjs", "check", str(SERVICE)], cwd=ROOT, env=base, capture_output=True, text=True)
    if stamp.returncode:
        p = subprocess.run(["npm", "--prefix", str(SERVICE), "run", "build"], cwd=ROOT, env=base, capture_output=True, text=True, timeout=900)
        if p.returncode:
            raise AssertionError("service build failed: " + (p.stderr + p.stdout)[-1500:])


class Db:
    def __init__(self, cluster, t295):
        self.cluster, self.t295 = cluster, t295

    def rows(self, statement, user=RUNTIME):
        out = self.cluster.sql("SELECT coalesce(json_agg(r),'[]') FROM (" + statement + ") r", user=user)
        return json.loads(out)

    def run(self, statement, user=RUNTIME):
        return self.cluster.sql(statement, user=user)

    def refused(self, statement, needle, user=RUNTIME):
        p = self.cluster.psql(user, self.t295.DATABASE, "-Atc", statement)
        return p.returncode != 0 and needle in p.stderr, p.stderr.strip()[-400:]


def seed(db, ids):
    D = "'sha256:'||repeat('a',64)"
    o = ids
    db.run(";".join([
        "BEGIN",
        f"INSERT INTO hyperfide.organisations(id,name) VALUES('{o['org']}','asks-probe')",
        f"INSERT INTO hyperfide.projects(organisation_id,id,name) VALUES('{o['org']}','{o['project']}','fixture')",
        f"INSERT INTO hyperfide.spec_revisions(organisation_id,id,project_id,source_digest,source_content,document,schema_version) VALUES('{o['org']}','{o['spec']}','{o['project']}','sha256:'||encode(sha256(convert_to('fixture','UTF8')),'hex'),'fixture','{{}}',1)",
        f"INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch,state) VALUES('{o['org']}','{o['run']}','{o['project']}','{o['spec']}',{D},'{o['epoch']}','RUNNING')",
        f"INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES('{o['org']}','{o['run']}','{o['package']}','package',1)",
        f"INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region) VALUES('{o['org']}','{o['pool']}','railway','fixture','fixture','fixture')",
        f"INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,observed_state) VALUES('{o['org']}','{o['sandbox']}','{o['pool']}','RUNNING')",
        f"INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES('{o['org']}','{o['slot']}','{o['sandbox']}','worker',1,'AGENT')",
        f"INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES('{o['org']}','{o['run']}','{o['task']}','3.1','{o['package']}','{o['spec']}',{D},'{{}}',1)",
        f"INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES('{o['org']}','{o['run']}','{o['attempt']}','{o['task']}',1,'{o['epoch']}',{D},'RUNNING','CURRENT','{o['sandbox']}','{o['slot']}',1,clock_timestamp()+interval '30 minutes')",
        f"INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,attempt_id,sandbox_id,slot_id,sandbox_boot_generation,state) VALUES('{o['org']}','{o['run']}','{o['session']}','WORKER','codex','fixture','w1','{o['attempt']}','{o['sandbox']}','{o['slot']}',1,'RUNNING')",
        "COMMIT",
    ]), user=db.t295.SUPERUSER)


def raise_sql(ids, kind, ask_id, policy, options, recommended, deadline, org_scoped=False):
    scoped = [None] * 4 if org_scoped else [ids["run"], ids["task"], ids["attempt"], ids["session"]]
    refs = ",".join(q(value) for value in scoped + [ids["sandbox"]])
    cols = "organisation_id,id,kind,title,body,options,recommended,deadline,default_policy,chain,raised_by,run_id,task,attempt,session,sandbox"
    return ("INSERT INTO hyperfide.asks(%s) VALUES(%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,'[\"leader\",\"operator\"]'::jsonb,%s,%s)" %
            (cols, q(ids["org"]), q(ask_id), q(kind), q("Need a " + kind), q("The " + kind + " the task cannot derive."),
             q(json.dumps(options)), q(recommended), deadline, q(policy), q(ids["worker"]), refs))


def scenario(db, ids):
    applied = db.rows("SELECT version,name FROM hyperfide.schema_migrations WHERE version=709", user=db.t295.SUPERUSER)
    tables = db.rows("SELECT to_regclass('hyperfide.asks')::text AS head,to_regclass('hyperfide.ask_events')::text AS events")
    check("migration.applied", applied == [{"version": 709, "name": "0709-asks"}] and tables == [{"head": "hyperfide.asks", "events": "hyperfide.ask_events"}], [applied, tables])

    asks = {kind: u() for kind in KINDS}
    soon = "clock_timestamp()+interval '2 seconds'"
    later = "clock_timestamp()+interval '1 day'"
    plan = {
        "secret": ("block", [], None, "NULL"),
        "variable": ("block", ["1800", "3600"], "3600", later),
        "permission": ("block", ["grant", "deny"], "deny", soon),
        "decision": ("proceed-and-flag", ["RETAIN", "DELETE"], "RETAIN", soon),
        "question": ("proceed-and-flag", ["yes", "no"], "yes", later),
    }
    for kind in KINDS:
        policy, options, recommended, deadline = plan[kind]
        db.run(raise_sql(ids, kind, asks[kind], policy, options, recommended, deadline, org_scoped=(kind == "secret")))

    head = {r["kind"]: r for r in db.rows("SELECT * FROM hyperfide.asks WHERE organisation_id=%s" % q(ids["org"]))}
    check("raise.each-kind-open", sorted(head) == sorted(KINDS) and all(
        r["state"] == "OPEN" and r["state_version"] == 1 and r["answer"] is None and r["answered_by"] is None and not r["decided_by_default"]
        and r["default_policy"] == plan[k][0] and r["options"] == plan[k][1] and r["recommended"] == plan[k][2] for k, r in head.items()), head)
    events = db.rows("SELECT * FROM hyperfide.ask_events WHERE organisation_id=%s ORDER BY ask_id,state_version" % q(ids["org"]))
    check("raise.event-per-kind", len(events) == 5 and all(
        e["event_type"] == "RAISED" and e["state"] == "OPEN" and e["state_version"] == 1 and e["actor"] == ids["worker"] for e in events)
        and {e["ask_id"] for e in events} == set(asks.values()), events)
    q_ = head.get("question", {})
    s_ = head.get("secret", {})
    check("raise.references-kept", q_.get("run_id") == ids["run"] and q_.get("task") == ids["task"] and q_.get("attempt") == ids["attempt"]
          and q_.get("session") == ids["session"] and q_.get("sandbox") == ids["sandbox"] and q_.get("chain") == ["leader", "operator"]
          and q_.get("raised_by") == ids["worker"] and s_.get("run_id") is None and s_.get("task") is None and s_.get("sandbox") == ids["sandbox"], [q_, s_])

    # Answer the variable as the operator.
    db.run("UPDATE hyperfide.asks SET state='ANSWERED',answer='3600',answered_by=%s,answered_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=%s AND id=%s"
           % (q(ids["operator"]), q(ids["org"]), q(asks["variable"])))
    v = db.rows("SELECT * FROM hyperfide.asks WHERE id=%s" % q(asks["variable"]))[0]
    check("answer.head", v["state"] == "ANSWERED" and v["answer"] == "3600" and v["answered_by"] == ids["operator"] and v["answered_at"]
          and v["state_version"] == 2 and not v["decided_by_default"] and v["expired_at"] is None, v)
    ve = db.rows("SELECT * FROM hyperfide.ask_events WHERE ask_id=%s ORDER BY state_version" % q(asks["variable"]))
    check("answer.event", [e["event_type"] for e in ve] == ["RAISED", "ANSWERED"] and ve[1]["state_version"] == 2 and ve[1]["actor"] == ids["operator"]
          and ve[1]["answer"] == "3600" and ve[1]["state"] == "ANSWERED" and not ve[1]["decided_by_default"], ve)

    # Negative checks that need no deadline to pass.
    ok, err = db.refused("UPDATE hyperfide.asks SET state='EXPIRED',answer=recommended,decided_by_default=true,expired_at=clock_timestamp(),state_version=state_version+1 WHERE id=%s" % q(asks["question"]),
                         "cannot expire before its deadline")
    check("refuse.early-expiry", ok, err)
    ok, err = db.refused("UPDATE hyperfide.asks SET answer='1800',answered_by=%s,answered_at=clock_timestamp(),state_version=state_version+1 WHERE id=%s" % (q(ids["operator"]), q(asks["variable"])),
                         "illegal ask transition ANSWERED -> ANSWERED")
    check("refuse.reanswer", ok, err)
    ok, err = db.refused("UPDATE hyperfide.asks SET state='ANSWERED',answer='yes',answered_by=%s,answered_at=clock_timestamp() WHERE id=%s" % (q(ids["operator"]), q(asks["question"])),
                         "state_version must advance by one")
    check("refuse.stale-state-version", ok, err)
    ok, err = db.refused("UPDATE hyperfide.asks SET title='renamed' WHERE id=%s" % q(asks["question"]), "immutable hyperfide.asks field title")
    check("refuse.immutable-field", ok, err)
    ok, err = db.refused("DELETE FROM hyperfide.asks WHERE id=%s" % q(asks["question"]), "asks are durable")
    check("refuse.delete-head", ok, err)
    upd, e1 = db.refused("UPDATE hyperfide.ask_events SET answer='x' WHERE ask_id=%s" % q(asks["variable"]), "append-only")
    dele, e2 = db.refused("DELETE FROM hyperfide.ask_events WHERE ask_id=%s" % q(asks["variable"]), "append-only")
    check("refuse.history-mutation", upd and dele, [e1, e2])
    ok, err = db.refused("INSERT INTO hyperfide.ask_events(organisation_id,ask_id,state_version,event_type,state,actor,answer,decided_by_default) VALUES(%s,%s,2,'ANSWERED','ANSWERED',%s,'no',false)"
                         % (q(ids["org"]), q(asks["question"]), q(ids["operator"])), "does not match the ask head")
    check("refuse.forged-event", ok, err)
    ok, err = db.refused(raise_sql(ids, "wish", u(), "block", [], None, "NULL"), "asks_kind_check")
    check("refuse.unknown-kind", ok, err)
    silent = [db.refused(raise_sql(ids, kind, u(), "proceed-and-flag", ["a", "b"], "a", later), "violates check constraint") for kind in ("secret", "variable", "permission")]
    check("refuse.silent-default-kind", all(r[0] for r in silent), silent)
    ok, err = db.refused(raise_sql(ids, "decision", u(), "proceed-and-flag", ["a", "b"], "c", later), "violates check constraint")
    check("refuse.recommended-outside-options", ok, err)
    raw, e1 = db.refused("UPDATE hyperfide.asks SET state='ANSWERED',answer='hunter2',answered_by=%s,answered_at=clock_timestamp(),state_version=state_version+1 WHERE id=%s"
                         % (q(ids["operator"]), q(asks["secret"])), "violates check constraint")
    check("refuse.secret-value", raw, e1)
    bogus = dict(ids, task=u())
    ok, err = db.refused(raise_sql(bogus, "question", u(), "proceed-and-flag", ["yes"], "yes", later), "violates foreign key constraint")
    check("refuse.unknown-task", ok, err)

    # Wait out the two-second deadlines, then expire both.
    for _ in range(100):
        due = db.rows("SELECT count(*) AS n FROM hyperfide.asks WHERE id IN (%s,%s) AND clock_timestamp()>=deadline" % (q(asks["decision"]), q(asks["permission"])))
        if due[0]["n"] == 2:
            break
        time.sleep(0.1)
    db.run("UPDATE hyperfide.asks SET state='EXPIRED',answer=recommended,decided_by_default=true,expired_at=clock_timestamp(),state_version=state_version+1 WHERE id=%s" % q(asks["decision"]))
    d = db.rows("SELECT * FROM hyperfide.asks WHERE id=%s" % q(asks["decision"]))[0]
    check("expire.default-taken-head", d["state"] == "EXPIRED" and d["answer"] == "RETAIN" and d["decided_by_default"] is True and d["answered_by"] is None
          and d["expired_at"] and d["state_version"] == 2, d)
    de = db.rows("SELECT * FROM hyperfide.ask_events WHERE ask_id=%s ORDER BY state_version" % q(asks["decision"]))
    check("expire.default-taken-event", [e["event_type"] for e in de] == ["RAISED", "EXPIRED"] and de[1]["actor"] is None and de[1]["answer"] == "RETAIN"
          and de[1]["decided_by_default"] is True and de[1]["state"] == "EXPIRED", de)
    ok, err = db.refused("UPDATE hyperfide.asks SET state='ANSWERED',answer='DELETE',answered_by=%s,answered_at=clock_timestamp(),decided_by_default=false,expired_at=NULL,state_version=state_version+1 WHERE id=%s"
                         % (q(ids["operator"]), q(asks["decision"])), "illegal ask transition EXPIRED -> ANSWERED")
    check("refuse.answer-after-default", ok, err)

    # A blocking Ask expires without a default and keeps waiting for a human answer.
    taken, e1 = db.refused("UPDATE hyperfide.asks SET state='EXPIRED',answer=recommended,decided_by_default=true,expired_at=clock_timestamp(),state_version=state_version+1 WHERE id=%s"
                           % q(asks["permission"]), "violates check constraint")
    db.run("UPDATE hyperfide.asks SET state='EXPIRED',expired_at=clock_timestamp(),state_version=state_version+1 WHERE id=%s" % q(asks["permission"]))
    p = db.rows("SELECT * FROM hyperfide.asks WHERE id=%s" % q(asks["permission"]))[0]
    check("expire.blocking-stays-unanswered", taken and p["state"] == "EXPIRED" and p["answer"] is None and not p["decided_by_default"] and p["state_version"] == 2, [e1, p])
    db.run("UPDATE hyperfide.asks SET state='ANSWERED',answer='grant',answered_by=%s,answered_at=clock_timestamp(),state_version=state_version+1 WHERE id=%s"
           % (q(ids["operator"]), q(asks["permission"])))
    p2 = db.rows("SELECT * FROM hyperfide.asks WHERE id=%s" % q(asks["permission"]))[0]
    pe = db.rows("SELECT event_type,actor,answer FROM hyperfide.ask_events WHERE ask_id=%s ORDER BY state_version" % q(asks["permission"]))
    check("expire.blocking-answered-late", p2["state"] == "ANSWERED" and p2["answer"] == "grant" and p2["expired_at"] == p["expired_at"] and p2["state_version"] == 3
          and [e["event_type"] for e in pe] == ["RAISED", "EXPIRED", "ANSWERED"] and pe[2]["actor"] == ids["operator"], [p2, pe])

    mismatch = db.rows("SELECT a.id FROM hyperfide.asks a WHERE a.organisation_id=%s AND ("
                       "(SELECT count(*) FROM hyperfide.ask_events e WHERE e.organisation_id=a.organisation_id AND e.ask_id=a.id)<>a.state_version OR "
                       "(SELECT array_agg(state_version ORDER BY state_version) FROM hyperfide.ask_events e WHERE e.organisation_id=a.organisation_id AND e.ask_id=a.id)<>"
                       "(SELECT array_agg(g::bigint ORDER BY g) FROM generate_series(1,a.state_version) g) OR "
                       "NOT EXISTS(SELECT 1 FROM hyperfide.ask_events e WHERE e.organisation_id=a.organisation_id AND e.ask_id=a.id AND e.state_version=a.state_version "
                       "AND e.state=a.state AND e.answer IS NOT DISTINCT FROM a.answer AND e.decided_by_default=a.decided_by_default))" % q(ids["org"]))
    final = db.rows("SELECT kind,state,state_version FROM hyperfide.asks WHERE organisation_id=%s ORDER BY kind" % q(ids["org"]))
    check("history.matches-head", mismatch == [] and final == [
        {"kind": "decision", "state": "EXPIRED", "state_version": 2}, {"kind": "permission", "state": "ANSWERED", "state_version": 3},
        {"kind": "question", "state": "OPEN", "state_version": 1}, {"kind": "secret", "state": "OPEN", "state_version": 1},
        {"kind": "variable", "state": "ANSWERED", "state_version": 2}], [mismatch, final])


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
        # Each migration commits on its own, so a run cut short by the 30 s deadline resumes where it stopped.
        for attempt in range(6):
            try:
                t295.node(t295.MIGRATE, {**base, "DATABASE_URL": cluster.url(t295.OPERATOR)})
                break
            except AssertionError as error:
                if attempt == 5 or "TX_TIMEOUT" not in str(error):
                    raise
        cluster.sql("CREATE ROLE " + RUNTIME + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT")
        t295.applied(cluster.grants(t295.OPERATOR, RUNTIME))
        names = ["org", "project", "spec", "run", "package", "pool", "sandbox", "slot", "task", "attempt", "session", "epoch", "worker", "operator"]
        ids = {name: u() for name in names}
        db = Db(cluster, t295)
        seed(db, ids)
        scenario(db, ids)
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
