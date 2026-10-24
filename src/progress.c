/*
 * Progress for the passes a person waits on: cg init, cg index, cg sync.
 *
 * A long pass on a big tree used to be silent until its summary line, and a
 * pass stuck behind another process's lock looked exactly like a slow one.
 * This draws one status line on stderr — phase, files done of files to do,
 * workers, what it waits for, elapsed, the path in hand — and erases it
 * before the summary, so a finished command leaves the output it always did.
 *
 * Contract:
 *   - Off unless the command asked for it (progress_request) AND the pass is
 *     neither quiet nor background (progress_begin). Every implicit sync —
 *     index_fresh, the hook, MCP, LSP, serve, watch, fleet, editors — reaches
 *     cg_index_ex without a request, so it can never draw.
 *   - Main thread only. Parse workers never call in; the counts come from
 *     what the consumer loop already holds, so the pipeline pays one clock
 *     read per popped file and nothing under its ring mutex.
 *   - stderr on a terminal: redrawn in place, first draw 250 ms after the
 *     request, at most every 100 ms. CG_PROGRESS=plain: a plain line on the
 *     first entry to each phase of a pass and at most every two seconds
 *     otherwise, terminal or not. CG_PROGRESS=0: never. Not a terminal and no
 *     CG_PROGRESS: never — piped output stays byte-identical.
 */
#include "cg.h"
#include <unistd.h>
#include <sys/ioctl.h>

#define FIRST_DRAW_MS  250
#define TTY_EVERY_MS   100
#define PLAIN_EVERY_MS 2000
#define WRITE_SLICE_MS 100
#define MAX_PHASES     8

enum { P_OFF, P_TTY, P_PLAIN };

static struct {
    int  mode;
    bool armed;          /* the command asked; set once by progress_request */
    bool muted;          /* this pass is quiet or background */
    long t0, last;
    bool shown;          /* a tty line is on screen and must be erased */
    bool dirty;          /* the state changed since the last line drawn */
    const char *phase;
    const char *printed[MAX_PHASES]; /* plain: phases entered this pass */
    int  nprinted;
    long done, total;
    long dirs;           /* the walk: directories read so far */
    char path[512];
    int  workers;
    const char *wait_what;
    long wait_ms;
} P;

static bool active(void) {
    return P.armed && !P.muted && P.mode != P_OFF;
}

static int term_width(void) {
    struct winsize ws;
    if (ioctl(STDERR_FILENO, TIOCGWINSZ, &ws) == 0 && ws.ws_col >= 20)
        return ws.ws_col;
    const char *c = getenv("COLUMNS");
    int n = c ? atoi(c) : 0;
    return n >= 20 ? n : 80;
}

static void erase(void) {
    if (!P.shown) return;
    fputs("\r\033[K", stderr);
    fflush(stderr);
    P.shown = false;
}

/* The path goes last so a narrow terminal truncates it, never the counts. */
static void compose(char *out, size_t cap, long now) {
    size_t n = 0;
#define ADD(...) do { if (n < cap) \
        n += (size_t)snprintf(out + n, cap - n, __VA_ARGS__); } while (0)
    ADD("cg: %s", P.phase ? P.phase : "starting");
    if (P.total > 0)     ADD(" %ld/%ld", P.done, P.total);
    else if (P.done > 0) ADD(" %ld file%s", P.done, P.done == 1 ? "" : "s");
    if (P.dirs > 0)      ADD(", %ld dir%s", P.dirs, P.dirs == 1 ? "" : "s");
    if (P.workers > 0)
        ADD(", %d worker%s", P.workers, P.workers == 1 ? "" : "s");
    if (P.wait_what)
        ADD(", waiting %.1fs for %s", (double)P.wait_ms / 1000.0, P.wait_what);
    ADD(", %.1fs", (double)(now - P.t0) / 1000.0);
    if (P.path[0]) ADD("  %s", P.path);
#undef ADD
}

/* entered: plain mode prints the first entry to each phase of a pass.
 * force: draw now — plain unconditionally, tty past the first-draw delay but
 * ahead of the tick throttle. Callers force only at bounded points (a step,
 * the walk's count, the start of a long silent step), never per file, so a
 * running phase still redraws at most ten times a second. */
static void render(bool entered, bool force) {
    if (!active()) return;
    long now = now_ms();
    char line[1024];
    if (P.mode == P_PLAIN) {
        bool first = false;
        if (entered && P.phase) {
            first = true;
            for (int i = 0; i < P.nprinted; i++)
                if (strcmp(P.printed[i], P.phase) == 0) { first = false; break; }
            if (first && P.nprinted < MAX_PHASES)
                P.printed[P.nprinted++] = P.phase;
        }
        if (!first && !(force && P.dirty) &&
            (!P.dirty || (P.last && now - P.last < PLAIN_EVERY_MS)))
            return;
        compose(line, sizeof line, now);
        fprintf(stderr, "%s\n", line);
        fflush(stderr);
        P.last = now;
        P.dirty = false;
        return;
    }
    /* a pass that ends inside the first quarter second never draws */
    if (now - P.t0 < FIRST_DRAW_MS) return;
    if (P.shown && !P.dirty) return;
    if (!force && P.shown && now - P.last < TTY_EVERY_MS) return;
    compose(line, sizeof line, now);
    int w = term_width() - 1;          /* a wrapped line cannot be erased */
    if (w < (int)sizeof line && (int)strlen(line) > w) line[w] = 0;
    fprintf(stderr, "\r\033[K%s", line);
    fflush(stderr);
    P.shown = true;
    P.last = now;
    P.dirty = false;
}

static void at_exit_erase(void) { erase(); }

void progress_request(bool want) {
    if (!want || P.armed) return;
    const char *e = getenv("CG_PROGRESS");
    if (e && strcmp(e, "0") == 0)          P.mode = P_OFF;
    else if (e && strcmp(e, "plain") == 0) P.mode = P_PLAIN;
    else if (isatty(STDERR_FILENO)) {
        const char *t = getenv("TERM");
        /* a terminal that cannot erase gets lines it can keep */
        P.mode = t && strcmp(t, "dumb") == 0 ? P_PLAIN : P_TTY;
    } else P.mode = P_OFF;
    if (P.mode == P_OFF) return;
    P.armed = true;
    P.t0 = now_ms();
    /* a busy database can exit(75) mid-pass; never leave half a line */
    atexit(at_exit_erase);
}

void progress_begin(const IndexOpts *o) {
    P.muted = o->quiet || o->background;
    P.nprinted = 0;
    P.done = P.total = 0;
    P.dirs = 0;
    P.path[0] = 0;
    P.workers = 0;
    P.wait_what = NULL;
}

void progress_step(const char *step) {
    if (!active()) return;
    P.nprinted = 0;
    P.workers = 0;
    P.phase = step;
    P.done = P.total = 0;
    P.path[0] = 0;
    P.dirty = true;
    render(true, true);
}

void progress_phase(const char *phase, long done, long total) {
    if (!active()) return;
    bool change = !P.phase || strcmp(P.phase, phase) != 0;
    P.phase = phase;
    P.done = done;
    P.total = total;
    if (change) { P.path[0] = 0; P.dirs = 0; }
    P.dirty = true;
    render(change, false);
}

/* codify-v15 1.3: the parallel walk counts directories as they are read */
void progress_dirs(long dirs) {
    if (!active()) return;
    P.dirs = dirs;
    P.dirty = true;
}

void progress_tick(long done, long total, const char *path) {
    if (!active()) return;
    P.done = done;
    P.total = total;
    if (path) snprintf(P.path, sizeof P.path, "%s", path);
    P.dirty = true;
    render(false, false);
}

void progress_flush(void) {
    render(false, true);
}

void progress_workers(int n) {
    if (active()) P.workers = n;
}

void progress_wait(const char *what, long waited_ms) {
    if (!active()) return;
    /* a wait that begins is news even in plain mode's two-second rhythm:
     * the line must say what it waits for before anyone takes it for a hang */
    bool begun = what && (!P.wait_what || strcmp(P.wait_what, what) != 0);
    P.wait_what = what;
    P.wait_ms = waited_ms;
    P.dirty = true;
    if (what) render(false, begun);
}

void progress_end(void) {
    erase();
    P.muted = false;
    P.phase = NULL;
    P.wait_what = NULL;
}

/* cg_begin_write with the wait made visible: the same total wait
 * (cg->lock_wait_ms, else CG_BUSY_TIMEOUT_MS), taken in short slices so the
 * line can say how long it has waited between them. Inactive, it is exactly
 * cg_begin_write — implicit passes and piped runs wait as they always did. */
int progress_begin_write(Cg *cg) {
    if (!active()) return cg_begin_write(cg);
    long saved = cg->lock_wait_ms;
    long wait = saved > 0 ? saved : cg_lock_wait_default();
    long start = now_ms(), waited = 0;
    int rc;
    for (;;) {
        long slice = wait - waited < WRITE_SLICE_MS ? wait - waited
                                                    : WRITE_SLICE_MS;
        if (slice < 1) slice = 1;
        cg->lock_wait_ms = slice;
        rc = cg_begin_write(cg);
        cg->lock_wait_ms = saved;
        if (rc == 0) break;
        waited = now_ms() - start;
        if (waited >= wait) break;
        progress_wait("the database write lock", waited);
    }
    progress_wait(NULL, 0);
    return rc;
}

/* Resolution reads a stable work list, then writes bounded, retryable chunks.
 * A live SELECT on the graph would retain its WAL snapshot across COMMIT and
 * prevent upgrading after another writer lands, so copy driving rows first. */
#include "index_chunks.h"
static Cg *chunk_owner;
static long chunk_started;
static int chunk_failed;

void index_chunks_begin_impl(Cg *cg) {
    chunk_owner = cg;
    chunk_started = now_ms();
    chunk_failed = 0;
}
void index_chunks_end_impl(void) { chunk_owner = NULL; }
int index_chunks_failed_impl(void) { return chunk_owner && chunk_failed; }
int index_chunks_active_impl(Cg *cg) { return chunk_owner == cg; }

static bool chunk_readers(Cg *cg) {
    for (sqlite3_stmt *s = sqlite3_next_stmt(cg->db, NULL); s;
         s = sqlite3_next_stmt(cg->db, s))
        if (sqlite3_stmt_busy(s)) return true;
    return false;
}

static int chunk_release(Cg *cg) {
    if (sqlite3_exec(cg->db, "COMMIT", NULL, NULL, NULL) != SQLITE_OK) {
        chunk_failed = 1;
        return -1;
    }
    /* SQLite's busy handler backs off to 100 ms. Leave a full retry
     * interval so a waiting writer cannot repeatedly miss shorter gaps. */
    sqlite3_sleep(125);
    return 0;
}
static int chunk_acquire(Cg *cg) {
    if (progress_begin_write(cg) != 0) {
        chunk_failed = 1;
        return -1;
    }
    chunk_started = now_ms();
    return 0;
}
int index_chunks_checkpoint_impl(Cg *cg) {
    if (chunk_owner != cg) return 0;
    if (chunk_failed) return -1;
    if (now_ms() - chunk_started < 1000 || chunk_readers(cg)) return 0;
    if (chunk_release(cg)) return -1;
    return chunk_acquire(cg);
}

int index_chunks_step_impl(Cg *cg, sqlite3_stmt **cursor) {
    if (chunk_owner != cg) return sqlite3_step(*cursor);
    if (chunk_failed) return SQLITE_ABORT;
    sqlite3_stmt *q = *cursor;
    if (sqlite3_db_handle(q) == cg->db && !chunk_readers(cg)) {
        if (chunk_release(cg)) return SQLITE_ABORT;
        sqlite3 *rows = NULL;
        sqlite3_stmt *put = NULL, *read = NULL;
        StrBuf sql; sb_init(&sql);
        int n = sqlite3_column_count(q), rc = sqlite3_open("", &rows);
        sb_puts(&sql, "CREATE TABLE work(");
        for (int i = 0; i < n; i++) sb_printf(&sql, "%sc%d", i ? "," : "", i);
        sb_puts(&sql, ")");
        if (rc == SQLITE_OK) rc = sqlite3_exec(rows, sql.p, NULL, NULL, NULL);
        if (rc == SQLITE_OK) rc = sqlite3_exec(rows,
            "PRAGMA cache_size=-2048; PRAGMA journal_mode=OFF; BEGIN", NULL, NULL, NULL);
        sb_free(&sql); sb_init(&sql);
        sb_puts(&sql, "INSERT INTO work VALUES(");
        for (int i = 0; i < n; i++) sb_printf(&sql, "%s?", i ? "," : "");
        sb_puts(&sql, ")");
        if (rc == SQLITE_OK) rc = sqlite3_prepare_v2(rows, sql.p, -1, &put, NULL);
        sb_free(&sql);
        if (rc == SQLITE_OK) {
            while ((rc = sqlite3_step(q)) == SQLITE_ROW) {
                for (int i = 0; i < n; i++)
                    sqlite3_bind_value(put, i + 1, sqlite3_column_value(q, i));
                rc = sqlite3_step(put);
                sqlite3_reset(put);
                if (rc != SQLITE_DONE) break;
            }
            if (rc == SQLITE_DONE) rc = SQLITE_OK;
        }
        sqlite3_finalize(put);
        if (rc == SQLITE_OK) rc = sqlite3_exec(rows, "COMMIT", NULL, NULL, NULL);
        sqlite3_finalize(q);
        *cursor = NULL;
        if (rc == SQLITE_OK)
            rc = sqlite3_prepare_v2(rows, "SELECT * FROM work ORDER BY rowid", -1, &read, NULL);
        if (rows) sqlite3_close_v2(rows); /* cursor owns the deferred close */
        *cursor = read;
        if (chunk_acquire(cg) || rc != SQLITE_OK) {
            chunk_failed = 1;
            return SQLITE_ABORT;
        }
    }
    /* At this outer-loop boundary all graph probes have been consumed;
     * single-row probes may still be positioned on SQLITE_ROW. */
    if (sqlite3_db_handle(*cursor) != cg->db) {
        for (sqlite3_stmt *s = sqlite3_next_stmt(cg->db, NULL); s;
             s = sqlite3_next_stmt(cg->db, s))
            if (sqlite3_stmt_busy(s) && sqlite3_stmt_readonly(s)) sqlite3_reset(s);
    }
    if (index_chunks_checkpoint(cg)) return SQLITE_ABORT;
    return sqlite3_step(*cursor);
}
