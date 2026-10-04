#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PATHNOD_NONCE_CAPACITY 300
#define PATHNOD_NONCE_TTL_US INT64_C(600000000)
#define PATHNOD_RATE_WINDOW_US INT64_C(60000000)
#define PATHNOD_CONNECTION_INTERVAL_US INT64_C(2000000)
#define PATHNOD_GLOBAL_LIMIT 30

typedef struct {
    uint8_t nonce[32];
    int64_t admitted, used;
    bool valid;
} pathnod_nonce_entry_t;
typedef struct {
    pathnod_nonce_entry_t nonces[PATHNOD_NONCE_CAPACITY];
    int64_t attempts[PATHNOD_GLOBAL_LIMIT], last_time;
    size_t count;
    bool time_seen;
} pathnod_guard_t;
typedef struct {
    int64_t last_attempt;
    bool attempted;
} pathnod_connection_limit_t;
typedef enum {
    PATHNOD_GUARD_OK, PATHNOD_GUARD_REPLAY, PATHNOD_GUARD_RATE, PATHNOD_GUARD_CLOCK
} pathnod_guard_result_t;

// Pure bounded LRU, with expiry based on admission, not replay touches.
bool pathnod_nonce_seen(pathnod_guard_t *guard, const uint8_t nonce[32], int64_t now);
void pathnod_nonce_insert(pathnod_guard_t *guard, const uint8_t nonce[32], int64_t now);
// Valid-length attempts consume rate quota, including replay/persistence failures.
// Keep guard for the entire boot; only reset connection_limit on reconnect.
pathnod_guard_result_t pathnod_guard_accept(pathnod_guard_t *guard,
    pathnod_connection_limit_t *connection_limit, const uint8_t nonce[32], int64_t now);
