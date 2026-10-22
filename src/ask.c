/* Asks: the one durable channel from an agent to a person (hyperfide-v21
 * req 3.3, task 3.4).
 *
 * An Ask is a row in `asks` with the shape of the service's hyperfide.asks
 * head (task 3.1): kind, title, body, options with one recommended, deadline,
 * default policy, escalation chain, the task, attempt, session and sandbox
 * it came from, who raised it and who answered. The event log is its
 * append-only history: ask.raised, ask.answered and ask.expired each carry
 * the row as it stands after the change, so a reader folds events onto the
 * snapshot's `asks` array without a second query.
 *
 * Policy per kind comes from [asks] in spec/workflow.kvx; D11 is the
 * fallback: secret, variable and permission block; decision and question
 * proceed on the recommended option and are flagged. On its deadline a
 * blocking Ask turns `expired` and keeps blocking; a proceed-and-flag Ask
 * is answered with its recommendation, marked decided_by_default, and the
 * default is written as a decision memory naming the Ask it replaced.
 *
 * Fleet approvals are the permission kind: fleet_gate raises a linked Ask
 * (fleet_approvals.ask_id), and answering either side decides the other. */
#include "cg.h"
#include <time.h>

static const char *KINDS[] = { "secret", "variable", "permission",
                               "decision", "question" };

#define ASK_COLS \
    "id,kind,title,ifnull(body,''),ifnull(options,'[]'),"             \
    "ifnull(recommended,''),ifnull(deadline,0),default_policy,"       \
    "ifnull(chain,'[]'),ifnull(task,''),ifnull(attempt,''),"          \
    "ifnull(session,''),ifnull(sandbox,''),ifnull(raised_by,''),"     \
    "raised,state,ifnull(answer,''),ifnull(answered_by,''),"          \
    "ifnull(answered,0),decided_by_default,ifnull(decision,0),"       \
    "state_version,ifnull(note,'')"

static bool kind_ok(const char *k) {
    for (size_t i = 0; i < sizeof KINDS / sizeof *KINDS; i++)
        if (strcmp(k, KINDS[i]) == 0) return true;
    return false;
}

/* malloc'd "block" or "proceed-and-flag" */
static char *kind_policy(Cg *cg, const char *kind) {
    char path[4700];
    char *p = NULL;
    config_workflow_path(cg->root, path, sizeof path);
    Kvx *wf = kvx_parse(path);
    if (wf) { p = kvx_str(wf, "asks", kind); kvx_free(wf); }
    if (p && (!strcmp(p, "block") || !strcmp(p, "proceed-and-flag")))
        return p;
    if (p)
        fprintf(stderr, "hyperfide ask: [asks] %s = \"%s\" is not block or "
                "proceed-and-flag; using the default\n", kind, p);
    free(p);
    bool blocks = !strcmp(kind, "secret") || !strcmp(kind, "variable") ||
                  !strcmp(kind, "permission");
    return xstrdup(blocks ? "block" : "proceed-and-flag");
}

/* "90", "90s", "5m", "2h", "1d" from now, or "@EPOCH"; -1 when malformed */
static long parse_deadline(const char *s, long now) {
    if (!s || !s[0]) return -1;
    char *end = NULL;
    if (s[0] == '@') {
        long at = strtol(s + 1, &end, 10);
        return end && !*end && at > 0 ? at : -1;
    }
    long n = strtol(s, &end, 10);
    if (end == s || n < 0) return -1;
    long mul = 1;
    if (*end == 's') end++;
    else if (*end == 'm') { mul = 60; end++; }
    else if (*end == 'h') { mul = 3600; end++; }
    else if (*end == 'd') { mul = 86400; end++; }
    return *end ? -1 : now + n * mul;
}

static void js(StrBuf *b, const char *key, const char *v) {
    sb_printf(b, ",\"%s\":", key);
    if (v && v[0]) sb_json_str(b, v); else sb_puts(b, "null");
}

/* one row selected with ASK_COLS, as JSON */
static void ask_row_json(sqlite3_stmt *st, long now, StrBuf *b) {
#define C(i) ((const char *)sqlite3_column_text(st, i))
#define I(i) ((long)sqlite3_column_int64(st, i))
    long deadline = I(6);
    const char *policy = C(7), *state = C(15);
    bool open = !strcmp(state, "open") || !strcmp(state, "expired");
    sb_printf(b, "{\"id\":%ld", I(0));
    js(b, "kind", C(1));
    js(b, "title", C(2));
    js(b, "body", C(3));
    sb_printf(b, ",\"options\":%s", C(4));
    js(b, "recommended", C(5));
    if (deadline > 0) sb_printf(b, ",\"deadline\":%ld", deadline);
    else sb_puts(b, ",\"deadline\":null");
    js(b, "default_policy", policy);
    sb_printf(b, ",\"chain\":%s", C(8));
    js(b, "task", C(9));
    js(b, "attempt", C(10));
    js(b, "session", C(11));
    js(b, "sandbox", C(12));
    js(b, "raised_by", C(13));
    sb_printf(b, ",\"raised\":%ld", I(14));
    js(b, "state", state);
    sb_printf(b, ",\"blocking\":%s",
              open && !strcmp(policy, "block") ? "true" : "false");
    sb_printf(b, ",\"overdue\":%s",
              open && deadline > 0 && deadline <= now ? "true" : "false");
    js(b, "answer", C(16));
    js(b, "answered_by", C(17));
    if (I(18) > 0) sb_printf(b, ",\"answered\":%ld", I(18));
    else sb_puts(b, ",\"answered\":null");
    sb_printf(b, ",\"decided_by_default\":%s", I(19) ? "true" : "false");
    if (I(20) > 0) sb_printf(b, ",\"decision\":%ld", I(20));
    else sb_puts(b, ",\"decision\":null");
    sb_printf(b, ",\"state_version\":%ld", I(21));
    js(b, "note", C(22));
    sb_putc(b, '}');
#undef C
#undef I
}

/* the row as JSON into b; false when there is no such Ask */
static bool ask_json(Cg *cg, long id, StrBuf *b) {
    sqlite3_stmt *st = cg_prep(cg, "SELECT " ASK_COLS " FROM asks WHERE id=?");
    if (!st) return false;
    sqlite3_bind_int64(st, 1, id);
    bool ok = sqlite3_step(st) == SQLITE_ROW;
    if (ok) ask_row_json(st, (long)time(NULL), b);
    sqlite3_finalize(st);
    return ok;
}

static void ask_event(Cg *cg, const char *kind, long id) {
    StrBuf p; sb_init(&p);
    if (ask_json(cg, id, &p)) {
        char subj[64];
        snprintf(subj, sizeof subj, "ask/%ld", id);
        events_emit(cg, kind, subj, p.p);
    }
    sb_free(&p);
}

static void bind_opt(sqlite3_stmt *st, int i, const char *v) {
    if (v && v[0]) sqlite3_bind_text(st, i, v, -1, SQLITE_TRANSIENT);
    else sqlite3_bind_null(st, i);
}

static void json_array(StrBuf *b, char **v, int n) {
    sb_putc(b, '[');
    for (int i = 0; i < n; i++) {
        if (i) sb_putc(b, ',');
        sb_json_str(b, v[i]);
    }
    sb_putc(b, ']');
}

static const char *env_or(const char *v, const char *name) {
    if (v && v[0]) return v;
    const char *e = getenv(name);
    return e && e[0] ? e : NULL;
}

static const char *person(void) {
    const char *by = getenv("CG_AGENT");
    if (!by || !by[0]) by = getenv("USER");
    return by && by[0] ? by : "unknown";
}

long ask_raise(Cg *cg, const AskSpec *a) {
    if (!a->kind || !kind_ok(a->kind)) {
        fprintf(stderr, "hyperfide ask: kind must be one of secret, variable, "
                "permission, decision, question\n");
        return -1;
    }
    if (!a->title || !a->title[0]) {
        fprintf(stderr, "hyperfide ask: an Ask needs a title\n");
        return -1;
    }
    char **opts = a->options;
    int nopt = a->noptions;
    char *perm[2] = { (char *)"approve", (char *)"reject" };
    char *one[1] = { (char *)a->recommended };
    if (!nopt && !strcmp(a->kind, "permission")) { opts = perm; nopt = 2; }
    if (!nopt && a->recommended && a->recommended[0]) { opts = one; nopt = 1; }
    if (a->recommended && a->recommended[0]) {
        bool found = false;
        for (int i = 0; i < nopt; i++)
            if (!strcmp(opts[i], a->recommended)) found = true;
        if (!found) {
            fprintf(stderr, "hyperfide ask: the recommended option \"%s\" is "
                    "not one of the options\n", a->recommended);
            return -1;
        }
    }
    char *policy = kind_policy(cg, a->kind);
    if (!strcmp(policy, "proceed-and-flag") &&
        (!a->recommended || !a->recommended[0])) {
        fprintf(stderr, "hyperfide ask: a %s Ask proceeds on its recommended "
                "option when unanswered; name it with --recommend\n", a->kind);
        free(policy);
        return -1;
    }
    StrBuf ob; sb_init(&ob); json_array(&ob, opts, nopt);
    StrBuf cb; sb_init(&cb); json_array(&cb, a->chain, a->nchain);
    sqlite3_stmt *st = cg_prep(cg,
        "INSERT INTO asks(kind,title,body,options,recommended,deadline,"
        "default_policy,chain,task,attempt,session,sandbox,raised_by,raised,"
        "state,decided_by_default,state_version,run) VALUES(?,?,?,?,?,?,?,?,"
        "?,?,?,?,?,?,'open',0,1,?)");
    long id = -1;
    if (st) {
        sqlite3_bind_text(st, 1, a->kind, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, a->title, -1, SQLITE_TRANSIENT);
        bind_opt(st, 3, a->body);
        sqlite3_bind_text(st, 4, ob.p, -1, SQLITE_TRANSIENT);
        bind_opt(st, 5, a->recommended);
        if (a->deadline > 0) sqlite3_bind_int64(st, 6, a->deadline);
        else sqlite3_bind_null(st, 6);
        sqlite3_bind_text(st, 7, policy, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 8, cb.p, -1, SQLITE_TRANSIENT);
        bind_opt(st, 9, env_or(a->task, "CG_TASK"));
        bind_opt(st, 10, env_or(a->attempt, "CG_ATTEMPT"));
        bind_opt(st, 11, env_or(a->session, "CG_SESSION"));
        bind_opt(st, 12, env_or(a->sandbox, "HYPERFIDE_SANDBOX"));
        bind_opt(st, 13, a->raised_by ? a->raised_by : person());
        sqlite3_bind_int64(st, 14, (long)time(NULL));
        bind_opt(st, 15, getenv("CG_RUN"));
        if (sqlite3_step(st) == SQLITE_DONE)
            id = (long)sqlite3_last_insert_rowid(cg->db);
        sqlite3_finalize(st);
    }
    sb_free(&ob); sb_free(&cb); free(policy);
    if (id < 0) {
        fprintf(stderr, "hyperfide ask: could not record the Ask: %s\n",
                sqlite3_errmsg(cg->db));
        return -1;
    }
    ask_event(cg, "ask.raised", id);
    spec_ask_transition(cg, id);
    return id;
}

/* the answer itself, once: 1 recorded, 0 already answered, -1 no such Ask */
int ask_record_answer(Cg *cg, long id, const char *answer, const char *by,
                      const char *note) {
    sqlite3_stmt *st = cg_prep(cg,
        "UPDATE asks SET state='answered',answer=?,answered_by=?,answered=?,"
        "note=ifnull(?,note),state_version=state_version+1 "
        "WHERE id=? AND state IN ('open','expired')");
    if (!st) return -1;
    sqlite3_bind_text(st, 1, answer, -1, SQLITE_TRANSIENT);
    bind_opt(st, 2, by);
    sqlite3_bind_int64(st, 3, (long)time(NULL));
    bind_opt(st, 4, note);
    sqlite3_bind_int64(st, 5, id);
    sqlite3_step(st);
    sqlite3_finalize(st);
    if (sqlite3_changes(cg->db) != 1) {
        sqlite3_stmt *q = cg_prep(cg, "SELECT 1 FROM asks WHERE id=?");
        sqlite3_bind_int64(q, 1, id);
        bool have = sqlite3_step(q) == SQLITE_ROW;
        sqlite3_finalize(q);
        return have ? 0 : -1;
    }
    ask_event(cg, "ask.answered", id);
    spec_ask_transition(cg, id);
    return 1;
}

int ask_expire_due(Cg *cg, long now) {
    sqlite3_stmt *st = cg_prep(cg,
        "SELECT id FROM asks WHERE state='open' AND deadline IS NOT NULL "
        "AND deadline>0 AND deadline<=? ORDER BY id");
    if (!st) return 0;
    sqlite3_bind_int64(st, 1, now);
    long ids[256];
    int n = 0;
    while (n < 256 && sqlite3_step(st) == SQLITE_ROW)
        ids[n++] = (long)sqlite3_column_int64(st, 0);
    sqlite3_finalize(st);
    int done = 0;
    for (int i = 0; i < n; i++) {
        sqlite3_stmt *q = cg_prep(cg,
            "SELECT kind,title,default_policy,ifnull(recommended,''),"
            "ifnull(task,'') FROM asks WHERE id=?");
        sqlite3_bind_int64(q, 1, ids[i]);
        if (sqlite3_step(q) != SQLITE_ROW) { sqlite3_finalize(q); continue; }
        char *kind = xstrdup((const char *)sqlite3_column_text(q, 0));
        char *title = xstrdup((const char *)sqlite3_column_text(q, 1));
        bool proceed = !strcmp((const char *)sqlite3_column_text(q, 2),
                               "proceed-and-flag");
        char *rec = xstrdup((const char *)sqlite3_column_text(q, 3));
        char *task = xstrdup((const char *)sqlite3_column_text(q, 4));
        sqlite3_finalize(q);
        /* the state guard makes a concurrent sweeper lose cleanly */
        sqlite3_stmt *u = cg_prep(cg, proceed
            ? "UPDATE asks SET state='answered',answer=?2,answered_by='default',"
              "answered=?3,decided_by_default=1,state_version=state_version+1 "
              "WHERE id=?1 AND state='open'"
            : "UPDATE asks SET state='expired',state_version=state_version+1 "
              "WHERE id=?1 AND state='open'");
        sqlite3_bind_int64(u, 1, ids[i]);
        if (proceed) {
            sqlite3_bind_text(u, 2, rec, -1, SQLITE_TRANSIENT);
            sqlite3_bind_int64(u, 3, now);
        }
        sqlite3_step(u);
        sqlite3_finalize(u);
        if (sqlite3_changes(cg->db) == 1) {
            if (proceed) {
                char body[1200];
                snprintf(body, sizeof body,
                         "Ask #%ld (%s) \"%s\" passed its deadline unanswered; "
                         "proceeded on the recommended option: %s",
                         ids[i], kind, title, rec);
                long mid = memory_add(cg, "decision", task[0] ? task : NULL,
                                      body, NULL, NULL, "ask");
                if (mid > 0) {
                    sqlite3_stmt *d = cg_prep(cg,
                        "UPDATE asks SET decision=? WHERE id=?");
                    sqlite3_bind_int64(d, 1, mid);
                    sqlite3_bind_int64(d, 2, ids[i]);
                    sqlite3_step(d);
                    sqlite3_finalize(d);
                }
            }
            ask_event(cg, "ask.expired", ids[i]);
            done++;
        }
        free(kind); free(title); free(rec); free(task);
    }
    return done;
}

void ask_list_json(Cg *cg, bool all, const char *task, StrBuf *b) {
    sqlite3_stmt *st = cg_prep(cg, all
        ? "SELECT " ASK_COLS " FROM asks WHERE (?1 IS NULL OR task=?1) "
          "ORDER BY id DESC LIMIT 200"
        : "SELECT " ASK_COLS " FROM asks WHERE state IN ('open','expired') "
          "AND (?1 IS NULL OR task=?1) ORDER BY id");
    sb_putc(b, '[');
    if (st) {
        bind_opt(st, 1, task);
        long now = (long)time(NULL);
        int n = 0;
        while (sqlite3_step(st) == SQLITE_ROW) {
            if (n++) sb_putc(b, ',');
            ask_row_json(st, now, b);
        }
        sqlite3_finalize(st);
    }
    sb_putc(b, ']');
}

/* ---------------- cg ask ---------------- */

static int ask_usage(const char *name) {
    help_usage(name);
    return 1;
}

static int ask_cmd_raise(Cg *cg, int argc, char **argv, bool json) {
    AskSpec a = {0};
    char *opts[32], *chain[16];
    char *chainbuf = NULL;
    const char *deadline = NULL;
    int pos = 0;
    a.options = opts; a.chain = chain;
    for (int i = 3; i < argc; i++) {
        const char *v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!strcmp(argv[i], "--option") && v) {
            if (a.noptions < 32) opts[a.noptions++] = argv[++i];
            else i++;
        } else if (!strcmp(argv[i], "--recommend") && v) a.recommended = argv[++i];
        else if (!strcmp(argv[i], "--body") && v) a.body = argv[++i];
        else if (!strcmp(argv[i], "--deadline") && v) deadline = argv[++i];
        else if (!strcmp(argv[i], "--chain") && v) chainbuf = xstrdup(argv[++i]);
        else if (!strcmp(argv[i], "--task") && v) a.task = argv[++i];
        else if (!strcmp(argv[i], "--attempt") && v) a.attempt = argv[++i];
        else if (!strcmp(argv[i], "--session") && v) a.session = argv[++i];
        else if (!strcmp(argv[i], "--sandbox") && v) a.sandbox = argv[++i];
        else if (argv[i][0] == '-' && argv[i][1]) {
            fprintf(stderr, "hyperfide ask raise: unknown flag %s\n", argv[i]);
            free(chainbuf);
            return ask_usage("ask raise");
        } else if (pos == 0) { a.kind = argv[i]; pos++; }
        else if (pos == 1) { a.title = argv[i]; pos++; }
        else {
            free(chainbuf);
            return ask_usage("ask raise");
        }
    }
    if (pos < 2) { free(chainbuf); return ask_usage("ask raise"); }
    if (chainbuf) {
        for (char *t = strtok(chainbuf, ","); t && a.nchain < 16;
             t = strtok(NULL, ","))
            if (*t) chain[a.nchain++] = t;
    }
    if (deadline) {
        a.deadline = parse_deadline(deadline, (long)time(NULL));
        if (a.deadline < 0) {
            fprintf(stderr, "hyperfide ask raise: --deadline takes 90s, 5m, "
                    "2h, 1d or @EPOCH, not \"%s\"\n", deadline);
            free(chainbuf);
            return 1;
        }
    }
    long id = ask_raise(cg, &a);
    free(chainbuf);
    if (id < 0) return 1;
    StrBuf b; sb_init(&b);
    ask_json(cg, id, &b);
    if (json) printf("%s\n", b.p);
    else {
        char *pol = json_get_string(b.p, "default_policy");
        printf("raised Ask #%ld (%s, %s)\n", id, a.kind, pol ? pol : "?");
        if (pol && !strcmp(pol, "block"))
            printf("this blocks the task until a person runs `hyperfide ask "
                   "answer %ld <answer>`\n", id);
        else
            printf("work continues on \"%s\"; a person may still answer with "
                   "`hyperfide ask answer %ld <answer>`\n", a.recommended, id);
        free(pol);
    }
    sb_free(&b);
    return 0;
}

static int ask_cmd_answer(Cg *cg, int argc, char **argv, bool json) {
    long id = 0;
    const char *answer = NULL, *note = NULL;
    for (int i = 3; i < argc; i++) {
        if (!strcmp(argv[i], "-m") && i + 1 < argc) note = argv[++i];
        else if (!id) id = atol(argv[i]);
        else if (!answer) answer = argv[i];
        else return ask_usage("ask answer");
    }
    if (id <= 0 || !answer || !answer[0]) return ask_usage("ask answer");
    sqlite3_stmt *q = cg_prep(cg, "SELECT kind,state,ifnull(options,'[]') "
                                  "FROM asks WHERE id=?");
    sqlite3_bind_int64(q, 1, id);
    if (sqlite3_step(q) != SQLITE_ROW) {
        sqlite3_finalize(q);
        fprintf(stderr, "hyperfide ask: no Ask #%ld\n", id);
        return 1;
    }
    char *kind = xstrdup((const char *)sqlite3_column_text(q, 0));
    char *state = xstrdup((const char *)sqlite3_column_text(q, 1));
    char *options = xstrdup((const char *)sqlite3_column_text(q, 2));
    sqlite3_finalize(q);
    int rc = 1;
    if (!strcmp(state, "answered")) {
        fprintf(stderr, "hyperfide ask: Ask #%ld is already answered\n", id);
        goto out;
    }
    if (strcmp(options, "[]") != 0) {
        StrBuf want; sb_init(&want); sb_json_str(&want, answer);
        bool listed = strstr(options, want.p) != NULL;
        sb_free(&want);
        if (!listed) {
            fprintf(stderr, "hyperfide ask: Ask #%ld takes one of %s\n", id,
                    options);
            goto out;
        }
    }
    /* a secret never enters the event log or the database as a value */
    if (!strcmp(kind, "secret") && strncmp(answer, "secret-ref:", 11) != 0) {
        fprintf(stderr, "hyperfide ask: a secret is answered with a reference "
                "(secret-ref:<id>), never its value\n");
        goto out;
    }
    const char *by = person();
    if (ask_record_answer(cg, id, answer, by, note) != 1) {
        fprintf(stderr, "hyperfide ask: Ask #%ld is already answered\n", id);
        goto out;
    }
    /* a fleet gate's Ask decides its approval as well */
    sqlite3_stmt *ap = cg_prep(cg, "SELECT id FROM fleet_approvals WHERE "
                                   "ask_id=? AND state='pending'");
    sqlite3_bind_int64(ap, 1, id);
    long apid = sqlite3_step(ap) == SQLITE_ROW ? sqlite3_column_int64(ap, 0) : 0;
    sqlite3_finalize(ap);
    if (apid)
        fleet_approval_decide(cg, apid, !strcmp(answer, "reject"), by, note,
                              false);
    if (json) {
        StrBuf b; sb_init(&b);
        ask_json(cg, id, &b);
        printf("%s\n", b.p);
        sb_free(&b);
    } else {
        printf("answered Ask #%ld: %s\n", id, answer);
    }
    rc = 0;
out:
    free(kind); free(state); free(options);
    return rc;
}

static int ask_cmd_list(Cg *cg, int argc, char **argv, bool json) {
    bool all = false;
    const char *task = NULL;
    for (int i = 3; i < argc; i++) {
        if (!strcmp(argv[i], "--all")) all = true;
        else if (!strcmp(argv[i], "--task") && i + 1 < argc) task = argv[++i];
        else return ask_usage("ask list");
    }
    StrBuf b; sb_init(&b);
    if (json) {
        sb_puts(&b, "{\"asks\":");
        ask_list_json(cg, all, task, &b);
        sb_puts(&b, "}\n");
        fputs(b.p, stdout);
        sb_free(&b);
        return 0;
    }
    sqlite3_stmt *st = cg_prep(cg, all
        ? "SELECT id,kind,default_policy,state,title,ifnull(task,''),"
          "ifnull(recommended,''),ifnull(answer,''),decided_by_default FROM "
          "asks WHERE (?1 IS NULL OR task=?1) ORDER BY id DESC LIMIT 200"
        : "SELECT id,kind,default_policy,state,title,ifnull(task,''),"
          "ifnull(recommended,''),ifnull(answer,''),decided_by_default FROM "
          "asks WHERE state IN ('open','expired') AND (?1 IS NULL OR task=?1) "
          "ORDER BY id");
    bind_opt(st, 1, task);
    int n = 0;
    while (sqlite3_step(st) == SQLITE_ROW) {
#define C(i) ((const char *)sqlite3_column_text(st, i))
        sb_printf(&b, "#%-4lld %-10s %-16s %-8s %s",
                  (long long)sqlite3_column_int64(st, 0), C(1), C(2), C(3),
                  C(4));
        if (C(5)[0]) sb_printf(&b, " [%s]", C(5));
        if (C(7)[0])
            sb_printf(&b, " -> %s%s", C(7),
                      sqlite3_column_int(st, 8) ? " (by default)" : "");
        else if (C(6)[0]) sb_printf(&b, " (recommended: %s)", C(6));
        sb_putc(&b, '\n');
#undef C
        n++;
    }
    sqlite3_finalize(st);
    if (!n) sb_puts(&b, all ? "no Asks recorded\n" : "no open Asks\n");
    fputs(b.p, stdout);
    sb_free(&b);
    return 0;
}

int cmd_ask(Cg *cg, int argc, char **argv, bool json) {
    const char *sub = argc >= 3 ? argv[2] : "list";
    if (strcmp(sub, "raise") == 0) return ask_cmd_raise(cg, argc, argv, json);
    if (strcmp(sub, "answer") == 0) return ask_cmd_answer(cg, argc, argv, json);
    if (strcmp(sub, "list") == 0) return ask_cmd_list(cg, argc, argv, json);
    if (strcmp(sub, "expire") == 0) {
        int n = ask_expire_due(cg, (long)time(NULL));
        if (json) printf("{\"expired\":%d}\n", n);
        else printf("%d Ask%s passed %s deadline\n", n, n == 1 ? "" : "s",
                    n == 1 ? "its" : "their");
        return 0;
    }
    return ask_usage("ask");
}
