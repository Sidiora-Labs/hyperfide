#ifndef HYPERFIDE_INDEX_CHUNKS_H
#define HYPERFIDE_INDEX_CHUNKS_H
/* Index-only checkpoints are optional for standalone semantic pass callers. */
extern void index_chunks_begin_impl(Cg *) __attribute__((weak));
extern void index_chunks_end_impl(void) __attribute__((weak));
extern int index_chunks_failed_impl(void) __attribute__((weak));
extern int index_chunks_active_impl(Cg *) __attribute__((weak));
extern int index_chunks_step_impl(Cg *, sqlite3_stmt **) __attribute__((weak));
extern int index_chunks_checkpoint_impl(Cg *) __attribute__((weak));
static inline void index_chunks_begin(Cg *cg) {
    if (index_chunks_begin_impl) index_chunks_begin_impl(cg);
}
static inline void index_chunks_end(void) {
    if (index_chunks_end_impl) index_chunks_end_impl();
}
static inline int index_chunks_failed(void) {
    return index_chunks_failed_impl ? index_chunks_failed_impl() : 0;
}
static inline int index_chunks_active(Cg *cg) {
    return index_chunks_active_impl ? index_chunks_active_impl(cg) : 0;
}
static inline int index_chunks_checkpoint(Cg *cg) {
    return index_chunks_checkpoint_impl ? index_chunks_checkpoint_impl(cg) : 0;
}
static inline int index_chunks_step(Cg *cg, sqlite3_stmt **q) {
    return index_chunks_step_impl ? index_chunks_step_impl(cg, q) : sqlite3_step(*q);
}
#endif
