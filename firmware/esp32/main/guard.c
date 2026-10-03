#include "guard.h"
#include <string.h>

bool pathnod_nonce_seen(pathnod_guard_t *guard, const uint8_t nonce[32], int64_t now)
{
    for (size_t i = 0; i < PATHNOD_NONCE_CAPACITY; ++i) {
        pathnod_nonce_entry_t *entry = &guard->nonces[i];
        if (entry->valid && now >= entry->admitted && now - entry->admitted >= PATHNOD_NONCE_TTL_US)
            entry->valid = false;
        if (entry->valid && memcmp(entry->nonce, nonce, 32) == 0) {
            entry->used = now;
            return true;
        }
    }
    return false;
}

void pathnod_nonce_insert(pathnod_guard_t *guard, const uint8_t nonce[32], int64_t now)
{
    size_t victim = 0;
    for (size_t i = 0; i < PATHNOD_NONCE_CAPACITY; ++i) {
        if (!guard->nonces[i].valid ||
            (now >= guard->nonces[i].admitted && now - guard->nonces[i].admitted >= PATHNOD_NONCE_TTL_US)) {
            victim = i;
            break;
        }
        if (guard->nonces[i].used < guard->nonces[victim].used) victim = i;
    }
    pathnod_nonce_entry_t *entry = &guard->nonces[victim];
    memcpy(entry->nonce, nonce, 32);
    entry->admitted = entry->used = now;
    entry->valid = true;
}

pathnod_guard_result_t pathnod_guard_accept(pathnod_guard_t *guard,
    pathnod_connection_limit_t *connection_limit, const uint8_t nonce[32], int64_t now)
{
    if (now < 0 || (guard->time_seen && now < guard->last_time)) return PATHNOD_GUARD_CLOCK;
    guard->last_time = now;
    guard->time_seen = true;
    if (connection_limit->attempted && now - connection_limit->last_attempt < PATHNOD_CONNECTION_INTERVAL_US)
        return PATHNOD_GUARD_RATE;
    size_t live = 0;
    for (size_t i = 0; i < guard->count; ++i)
        if (now - guard->attempts[i] < PATHNOD_RATE_WINDOW_US)
            guard->attempts[live++] = guard->attempts[i];
    guard->count = live;
    if (live == PATHNOD_GLOBAL_LIMIT) return PATHNOD_GUARD_RATE;
    connection_limit->attempted = true;
    connection_limit->last_attempt = now;
    guard->attempts[guard->count++] = now;
    if (pathnod_nonce_seen(guard, nonce, now)) return PATHNOD_GUARD_REPLAY;
    // Reserve before signing: ambiguous failures must not allow immediate reuse.
    pathnod_nonce_insert(guard, nonce, now);
    return PATHNOD_GUARD_OK;
}
