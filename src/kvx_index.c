/*
 * kvx_index: hash index over a parsed Kvx's (section, key) entries so
 * kvx_raw answers in O(1) instead of scanning every entry. Per-task spec
 * commands (status, next, ready) look up several keys per task; with a
 * linear kvx_raw that is O(tasks * entries). Built once after parse; a Kvx
 * is never mutated after kvx_parse returns.
 */
#include "cg.h"

typedef struct { int *slot; size_t mask; } KvxIndex;

static size_t kvx_index_hash(const char *sec, const char *key) {
    uint64_t h = 1469598103934665603ULL;
    for (const unsigned char *p = (const unsigned char *)sec; *p; p++)
        h = (h ^ *p) * 1099511628211ULL;
    h = (h ^ 0xffu) * 1099511628211ULL;
    for (const unsigned char *p = (const unsigned char *)key; *p; p++)
        h = (h ^ *p) * 1099511628211ULL;
    return (size_t)h;
}

void kvx_index_build(Kvx *k) {
    kvx_index_free(k);
    size_t cap = 16;
    while (cap < (size_t)k->n * 2) cap <<= 1;
    KvxIndex *ix = xmalloc(sizeof *ix);
    ix->slot = xmalloc(sizeof(int) * cap);
    for (size_t i = 0; i < cap; i++) ix->slot[i] = -1;
    ix->mask = cap - 1;
    for (int i = 0; i < k->n; i++) {
        size_t h = kvx_index_hash(k->v[i].section, k->v[i].key) & ix->mask;
        for (;;) {
            int e = ix->slot[h];
            if (e < 0) { ix->slot[h] = i; break; }
            /* first occurrence wins, matching the linear scan */
            if (strcmp(k->v[e].section, k->v[i].section) == 0 &&
                strcmp(k->v[e].key, k->v[i].key) == 0) break;
            h = (h + 1) & ix->mask;
        }
    }
    k->idx = ix;
}

int kvx_index_find(const Kvx *k, const char *sec, const char *key) {
    const KvxIndex *ix = k->idx;
    size_t h = kvx_index_hash(sec, key) & ix->mask;
    for (;;) {
        int e = ix->slot[h];
        if (e < 0) return -1;
        if (strcmp(k->v[e].section, sec) == 0 && strcmp(k->v[e].key, key) == 0)
            return e;
        h = (h + 1) & ix->mask;
    }
}

void kvx_index_free(Kvx *k) {
    KvxIndex *ix = k->idx;
    if (!ix) return;
    free(ix->slot);
    free(ix);
    k->idx = NULL;
}
