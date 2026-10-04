#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sodium.h>
#include "identity.h"
#include "advertising.h"
#include "base58.h"
#include "nvs.h"
#include "sdkconfig.h"
#include "session.h"

static uint8_t stored_seed[32];
static bool exists, encrypted = true;
static size_t stored_length = 32;
static int sets, commits, opens, closes;
static esp_err_t open_error, read_error, write_error, commit_error;
static bool counter_exists, mode_exists, pending_counter_exists, pending_mode_exists;
static bool ambiguous_commit;
static uint32_t stored_counter, stored_mode, pending_counter, pending_mode;
static esp_err_t counter_write_error, mode_write_error, counter_read_error;

bool esp_flash_encryption_enabled(void) { return encrypted; }
esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle)
{
    assert(strcmp(name, "pathnod") == 0 && mode == NVS_READWRITE);
    opens++;
    *handle = 1;
    pending_counter_exists = counter_exists; pending_mode_exists = mode_exists;
    pending_counter = stored_counter; pending_mode = stored_mode;
    return open_error;
}
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *out, size_t *length)
{
    assert(handle == 1 && strcmp(key, "ed25519_seed") == 0);
    if (read_error) return read_error;
    if (!exists) return ESP_ERR_NVS_NOT_FOUND;
    if (*length < stored_length) return ESP_ERR_INVALID_SIZE;
    memcpy(out, stored_seed, stored_length);
    *length = stored_length;
    return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *seed, size_t length)
{
    assert(handle == 1 && strcmp(key, "ed25519_seed") == 0 && length == 32);
    sets++;
    if (write_error) return write_error;
    memcpy(stored_seed, seed, length);
    exists = true;
    return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t handle)
{
    assert(handle == 1); commits++;
    if (commit_error == ESP_OK || ambiguous_commit) {
        counter_exists = pending_counter_exists; mode_exists = pending_mode_exists;
        stored_counter = pending_counter; stored_mode = pending_mode;
    }
    return commit_error;
}
void nvs_close(nvs_handle_t handle) { assert(handle == 1); closes++; }

esp_err_t nvs_get_u32(nvs_handle_t handle, const char *key, uint32_t *value)
{
    assert(handle == 1);
    if (counter_read_error) return counter_read_error;
    if (strcmp(key, "counter_v1") == 0) {
        if (!counter_exists) return ESP_ERR_NVS_NOT_FOUND;
        *value = stored_counter;
    } else {
        assert(strcmp(key, "counter_mode") == 0);
        if (!mode_exists) return ESP_ERR_NVS_NOT_FOUND;
        *value = stored_mode;
    }
    return ESP_OK;
}
esp_err_t nvs_set_u32(nvs_handle_t handle, const char *key, uint32_t value)
{
    assert(handle == 1);
    if (strcmp(key, "counter_v1") == 0) {
        if (counter_write_error) return counter_write_error;
        pending_counter = value; pending_counter_exists = true;
    } else {
        assert(strcmp(key, "counter_mode") == 0);
        if (mode_write_error) return mode_write_error;
        pending_mode = value; pending_mode_exists = true;
    }
    return ESP_OK;
}

static void test_identity(void)
{
    pathnod_identity_t first, reboot;
    assert(pathnod_identity_init(NULL) == ESP_ERR_INVALID_ARG);
#if CONFIG_PATHNOD_REQUIRE_ENCRYPTED_STORAGE
    encrypted = false;
    assert(pathnod_identity_init(&first) == ESP_ERR_INVALID_STATE);
    assert(opens == 0 && sets == 0);
    encrypted = true;
#endif
    assert(pathnod_identity_init(&first) == ESP_OK);
    assert(sets == 1 && commits == 1 && closes == 1);
    assert(pathnod_identity_init(&reboot) == ESP_OK);
    assert(memcmp(&first, &reboot, sizeof(first)) == 0);
    assert(sets == 1 && commits == 1 && closes == 2);

    // Deterministic interoperability vector: seed 00..1f.
    for (size_t i = 0; i < 32; ++i) stored_seed[i] = (uint8_t)i;
    assert(pathnod_identity_init(&first) == ESP_OK);
    uint8_t expected_pk[32], expected_id[32];
    assert(sodium_hex2bin(expected_pk, 32,
        "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8",
        64, NULL, NULL, NULL) == 0);
    assert(memcmp(first.public_key, expected_pk, 32) == 0);
    uint8_t message[49]; // 17-byte domain + 32-byte public key, no NUL.
    memcpy(message, "Pathnod/device/v0", 17);
    memcpy(message + 17, expected_pk, 32);
    crypto_hash_sha256(expected_id, message, sizeof(message));
    assert(memcmp(first.device_id, expected_id, 32) == 0);

    stored_length = 31;
    assert(pathnod_identity_init(&first) == ESP_ERR_INVALID_SIZE);
    stored_length = 33;
    assert(pathnod_identity_init(&first) == ESP_ERR_INVALID_SIZE);
    stored_length = 32;
    read_error = ESP_FAIL;
    assert(pathnod_identity_init(&first) == ESP_FAIL);
    read_error = ESP_OK;
    assert(sets == 1); // Storage errors never regenerate the key.
    open_error = ESP_FAIL;
    assert(pathnod_identity_init(&first) == ESP_FAIL);
    open_error = ESP_OK;
    exists = false; write_error = ESP_FAIL;
    assert(pathnod_identity_init(&first) == ESP_FAIL);
    write_error = ESP_OK; commit_error = ESP_FAIL;
    assert(pathnod_identity_init(&first) == ESP_FAIL);
    assert(opens == closes + 1); // Only failed open needs no close.
}

static void test_advertising(void)
{
    uint8_t id[32], adv[PATHNOD_ADV_LENGTH], rsp[PATHNOD_SCAN_RSP_LENGTH];
    for (size_t i = 0; i < 32; ++i) id[i] = (uint8_t)i;
    pathnod_advertising_encode(id, adv, rsp);
    assert(sizeof(adv) <= 31 && sizeof(rsp) <= 31);
    assert(adv[0] == 2 && adv[1] == 1 && adv[2] == 6);
    assert(adv[3] == 17 && adv[4] == 7);
    const uint8_t uuid[] = {1,0,0,0,0,0,0,0,0,0,0,0x4c,0x45,0x56,0x4f,0x53};
    assert(memcmp(adv + 5, uuid, 16) == 0);
    assert(rsp[0] == 25 && rsp[1] == 0x21);
    assert(memcmp(rsp + 2, uuid, 16) == 0);
    assert(memcmp(rsp + 18, id, 8) == 0);
}

static void test_challenge_response(void)
{
    uint8_t challenge[44], response[78], digest[32];
    for (size_t i = 0; i < sizeof(challenge); ++i) challenge[i] = (uint8_t)i;
    assert(pathnod_identity_respond(challenge, 44, response) == ESP_ERR_INVALID_STATE);
    commit_error = ESP_OK; exists = true;
    for (size_t i = 0; i < 32; ++i) stored_seed[i] = (uint8_t)i;
    pathnod_identity_t identity;
    assert(pathnod_identity_init(&identity) == ESP_OK);
    uint8_t info[70];
    pathnod_identity_info(&identity, info);
    assert(info[0] == 0 && info[1] == 1 && memcmp(info + 2, identity.public_key, 32) == 0);
    assert(info[34] == 0 && info[35] == 0 && info[36] == 0);
#if CONFIG_PATHNOD_HELIUM_EMULATION
    // Bits 1, 3 and 5; the hint is the configured asset ID (SPL Token program ID).
    assert(info[37] == 0x2a);
    uint8_t asset[32];
    assert(sodium_hex2bin(asset, 32,
        "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9",
        64, NULL, NULL, NULL) == 0);
    assert(memcmp(info + 38, asset, 32) == 0);
    assert(memcmp(identity.protocol_hint, asset, 32) == 0);
#else
    assert(info[37] == 10);
    for (size_t i = 38; i < 70; ++i) assert(info[i] == 0);
#endif
    assert(pathnod_identity_respond(challenge, 44, response) == ESP_OK);
    // Independent Node.js/OpenSSL Ed25519 vector (public test seed 00..1f).
    uint8_t expected_signature[64];
    assert(sodium_hex2bin(expected_signature, 64,
        "8db53a47b9b97842d10b1869b3b77d6760ee37635490c0aff948bb543f193331d"
        "84a23ca20908f6fb28651109e776d235b2d0bbdf153320624477c28f4e0c605",
        128, NULL, NULL, NULL) == 0);
    assert(memcmp(response, expected_signature, sizeof(expected_signature)) == 0);
    // Independent layout: 20 domain + nonce32 + epoch4 + hint8 + ts8 +
    // counter4 + evidence_hash32. Signing the raw message must NOT verify.
    uint8_t message[108] = {0};
    memcpy(message, "Pathnod/challenge/v0", 20);
    memcpy(message + 20, challenge, 44);
    message[75] = 1;
    crypto_hash_sha256(digest, message, sizeof(message));
    assert(crypto_sign_verify_detached(response, digest, 32, identity.public_key) == 0);
    assert(crypto_sign_verify_detached(response, message, 108, identity.public_key) != 0);
    for (size_t i = 64; i < 78; ++i) if (i != 75) assert(response[i] == 0);
    assert(response[75] == 1);
    for (size_t i = 20; i < 108; ++i) {
        message[i] ^= 1;
        crypto_hash_sha256(digest, message, sizeof(message));
        assert(crypto_sign_verify_detached(response, digest, 32, identity.public_key) != 0);
        message[i] ^= 1;
    }
    pathnod_session_t session;
    pathnod_guard_t guard = {0};
    pathnod_session_reset(&session);
    assert(pathnod_session_challenge(&session, 7, challenge, 44, &guard, 0) == ESP_ERR_INVALID_STATE);
    pathnod_session_connect(&session, 7);
    assert(pathnod_session_challenge(&session, 8, challenge, 44, &guard, 0) == ESP_ERR_INVALID_STATE);
    assert(pathnod_session_challenge(&session, 7, challenge, 44, &guard, 0) == ESP_OK && session.valid);
    for (size_t length = 0; length <= 45; ++length) {
        if (length == 44) continue;
        assert(pathnod_session_challenge(&session, 7, challenge, length, &guard, 0) == ESP_ERR_INVALID_ARG);
        assert(!session.valid);
        for (size_t i = 0; i < 78; ++i) assert(session.response[i] == 0);
    }
    assert(pathnod_session_challenge(&session, 7, NULL, 44, &guard, 0) == ESP_ERR_INVALID_ARG);
    assert(pathnod_identity_respond(challenge, 44, NULL) == ESP_ERR_INVALID_ARG);
    assert(pathnod_session_challenge(&session, 7, challenge, 44, &guard, 2000000) == ESP_ERR_INVALID_STATE);
    assert(!session.valid); // Replay fails even after the connection interval.
    challenge[0] ^= 1;
    assert(pathnod_session_challenge(&session, 7, challenge, 44, &guard, 4000000) == ESP_OK);
    session.subscribed = true;
    pathnod_session_connect(&session, 7); // Reused connection handle is a new session.
    assert(!session.valid && !session.subscribed);
    assert(pathnod_session_challenge(&session, 7, challenge, 44, &guard, 6000000) == ESP_ERR_INVALID_STATE);
    pathnod_session_reset(&session);
    assert(!pathnod_session_matches(&session, 7));
    open_error = ESP_FAIL;
    assert(pathnod_identity_init(&identity) == ESP_FAIL);
    assert(pathnod_identity_respond(challenge, 44, response) == ESP_ERR_INVALID_STATE);
    open_error = ESP_OK;
}

static uint32_t response_counter(const uint8_t response[78])
{
    return (uint32_t)response[72] << 24 | (uint32_t)response[73] << 16 |
           (uint32_t)response[74] << 8 | response[75];
}

static void test_session_persistence_failure(void)
{
    pathnod_identity_t identity;
    pathnod_session_t session;
    pathnod_guard_t guard = {0};
    uint8_t challenge[44] = {0};
    counter_exists = mode_exists = false;
    assert(pathnod_identity_init(&identity) == ESP_OK);
    pathnod_session_connect(&session, 4);
    commit_error = ESP_FAIL;
    assert(pathnod_session_challenge(&session, 4, challenge, 44, &guard, 0) == ESP_FAIL);
    assert(!session.valid);
    for (size_t i = 0; i < 78; ++i) assert(session.response[i] == 0);
    commit_error = ESP_OK;
    assert(pathnod_identity_init(&identity) == ESP_OK);
    challenge[43] = 1; // Same nonce with a new hint is still a replay.
    assert(pathnod_session_challenge(&session, 4, challenge, 44, &guard, 2000000) == ESP_ERR_INVALID_STATE);
    assert(!session.valid);
    challenge[0] = 1;
    assert(pathnod_session_challenge(&session, 4, challenge, 44, &guard, 4000000) == ESP_OK);
    assert(session.valid && response_counter(session.response) == 1);
    challenge[0] = 2;
    assert(pathnod_session_challenge(&session, 4, challenge, 44, &guard, 5999999) == ESP_ERR_INVALID_STATE);
    assert(!session.valid);
    assert(pathnod_session_challenge(&session, 4, challenge, 44, &guard, 6000000) == ESP_OK);
    assert(session.valid && response_counter(session.response) == 2);
}

static void test_counter(void)
{
    pathnod_identity_t identity;
    uint8_t challenge[44] = {0}, response[78];
    uint32_t previous = 0;
    counter_exists = mode_exists = false;
    assert(pathnod_identity_init(&identity) == ESP_OK); // Migration keeps key.
    int before = commits;
    for (uint32_t i = 1; i <= 65; ++i) {
        assert(pathnod_identity_respond(challenge, 44, response) == ESP_OK);
        assert(response_counter(response) == i);
        previous = i;
    }
    assert(commits == before + 2 && stored_counter == 128 && stored_mode == 1);
    assert(pathnod_identity_init(&identity) == ESP_OK); // Simulated restart.
    assert(pathnod_identity_respond(challenge, 44, response) == ESP_OK);
    assert(response_counter(response) == 129 && response_counter(response) > previous);
    for (int failure = 0; failure < 5; ++failure) {
        assert(pathnod_identity_init(&identity) == ESP_OK);
        if (failure == 0) open_error = ESP_FAIL;
        if (failure == 1) counter_write_error = ESP_FAIL;
        if (failure == 2) mode_write_error = ESP_FAIL;
        if (failure >= 3) commit_error = ESP_FAIL;
        ambiguous_commit = failure == 4;
        memset(response, 0xff, sizeof(response));
        assert(pathnod_identity_respond(challenge, 44, response) == ESP_FAIL);
        for (size_t i = 0; i < sizeof(response); ++i) assert(response[i] == 0);
        assert(pathnod_identity_respond(challenge, 44, response) == ESP_ERR_INVALID_STATE);
        open_error = counter_write_error = mode_write_error = commit_error = ESP_OK;
        ambiguous_commit = false;
        assert(pathnod_identity_init(&identity) == ESP_OK);
        assert(pathnod_identity_respond(challenge, 44, response) == ESP_OK);
        assert(response_counter(response) > previous);
        previous = response_counter(response);
    }
    counter_read_error = ESP_FAIL;
    assert(pathnod_identity_init(&identity) == ESP_FAIL);
    assert(pathnod_identity_respond(challenge, 44, response) == ESP_ERR_INVALID_STATE);
    counter_read_error = ESP_OK;
    counter_exists = false; // Missing state is not a fresh counter once marked.
    assert(pathnod_identity_init(&identity) == ESP_ERR_INVALID_STATE);
    counter_exists = true; stored_mode = 2;
    assert(pathnod_identity_init(&identity) == ESP_ERR_INVALID_STATE);
    stored_mode = 1; stored_counter = UINT32_MAX - 1;
    assert(pathnod_identity_init(&identity) == ESP_OK);
    assert(pathnod_identity_respond(challenge, 44, response) == ESP_OK);
    assert(response_counter(response) == UINT32_MAX);
    assert(pathnod_identity_respond(challenge, 44, response) == ESP_ERR_INVALID_STATE);
    for (size_t i = 0; i < sizeof(response); ++i) assert(response[i] == 0);
    assert(pathnod_identity_init(&identity) == ESP_ERR_INVALID_STATE);
#if CONFIG_PATHNOD_HELIUM_EMULATION
    assert(PATHNOD_CAPABILITIES == ((1u << 1) | (1u << 3) | (1u << 5)));
#else
    assert(PATHNOD_CAPABILITIES == ((1u << 1) | (1u << 3)));
#endif
}

static void nonce_for(uint8_t nonce[32], uint32_t index)
{
    memset(nonce, 0, 32);
    for (size_t i = 0; i < 4; ++i) nonce[i] = (uint8_t)(index >> (8 * i));
}

static void test_power_cut_snapshots(void)
{
    // Persisted outcomes around reservation 65..128: old/new ceiling and a
    // torn marker. This models reboot state, not real flash atomicity.
    pathnod_identity_t identity;
    uint8_t challenge[44] = {0}, response[78], public_key[32];
    counter_exists = mode_exists = true; stored_mode = 1; stored_counter = 64;
    assert(pathnod_identity_init(&identity) == ESP_OK);
    memcpy(public_key, identity.public_key, sizeof(public_key));
    for (int snapshot = 0; snapshot < 4; ++snapshot) {
        counter_exists = snapshot != 2;
        mode_exists = snapshot != 3;
        stored_mode = 1;
        stored_counter = snapshot == 0 ? 64 : 128;
        esp_err_t result = pathnod_identity_init(&identity);
        if (snapshot == 2) {
            assert(result == ESP_ERR_INVALID_STATE); // Marker without ceiling.
            memset(response, 0xff, sizeof(response));
            assert(pathnod_identity_respond(challenge, 44, response) == ESP_ERR_INVALID_STATE);
            for (size_t i = 0; i < sizeof(response); ++i) assert(response[i] == 0);
        } else {
            assert(result == ESP_OK);
            assert(memcmp(public_key, identity.public_key, sizeof(public_key)) == 0);
            assert(pathnod_identity_respond(challenge, 44, response) == ESP_OK);
            assert(response_counter(response) == (snapshot == 0 ? 65 : 129));
            assert(mode_exists && stored_mode == 1);
        }
    }
}

static void test_session_global_window(void)
{
    pathnod_identity_t identity;
    pathnod_session_t session = {0};
    pathnod_guard_t guard = {0};
    uint8_t challenge[44] = {0};
    counter_exists = mode_exists = false;
    assert(pathnod_identity_init(&identity) == ESP_OK);
    for (uint32_t i = 0; i < 30; ++i) {
        pathnod_session_connect(&session, 4);
        challenge[0] = (uint8_t)i;
        assert(pathnod_session_challenge(&session, 4, challenge, 44, &guard,
                                        (int64_t)i * 1000000) == ESP_OK);
        pathnod_session_reset(&session);
    }
    pathnod_session_connect(&session, 4);
    challenge[0] = 30;
    assert(pathnod_session_challenge(&session, 4, challenge, 44, &guard, 59999999) == ESP_ERR_INVALID_STATE);
    assert(!session.valid);
    for (size_t i = 0; i < sizeof(session.response); ++i) assert(session.response[i] == 0);
    assert(pathnod_session_challenge(&session, 4, challenge, 44, &guard, 60000000) == ESP_OK);
    assert(response_counter(session.response) == 31); // Rejection never signs.
}

static void test_guard(void)
{
    pathnod_guard_t guard = {0};
    pathnod_connection_limit_t connection = {0};
    uint8_t nonce[32]; nonce_for(nonce, 0);
    assert(pathnod_guard_accept(&guard, &connection, nonce, 0) == PATHNOD_GUARD_OK);
    nonce_for(nonce, 1);
    assert(pathnod_guard_accept(&guard, &connection, nonce, 1999999) == PATHNOD_GUARD_RATE);
    assert(pathnod_guard_accept(&guard, &connection, nonce, 2000000) == PATHNOD_GUARD_OK);
    assert(pathnod_guard_accept(&guard, &connection, nonce, 4000000) == PATHNOD_GUARD_REPLAY);
    // Replay touches do not extend the 10-minute retention period.
    assert(pathnod_nonce_seen(&guard, nonce, 601999999));
    assert(!pathnod_nonce_seen(&guard, nonce, 602000000));
    memset(&guard, 0, sizeof(guard));
    for (uint32_t i = 0; i < 30; ++i) {
        connection = (pathnod_connection_limit_t){0}; // Reconnect must not clear global quota.
        nonce_for(nonce, i);
        assert(pathnod_guard_accept(&guard, &connection, nonce, i) == PATHNOD_GUARD_OK);
    }
    connection = (pathnod_connection_limit_t){0}; nonce_for(nonce, 30);
    assert(pathnod_guard_accept(&guard, &connection, nonce, 59999999) == PATHNOD_GUARD_RATE);
    assert(pathnod_guard_accept(&guard, &connection, nonce, 60000000) == PATHNOD_GUARD_OK);
    assert(pathnod_guard_accept(&guard, &connection, nonce, 59999999) == PATHNOD_GUARD_CLOCK);
    assert(pathnod_guard_accept(&guard, &connection, nonce, -1) == PATHNOD_GUARD_CLOCK);
    // Direct cache test isolates LRU eviction independently from quota enforcement.
    memset(&guard, 0, sizeof(guard));
    for (uint32_t i = 0; i < PATHNOD_NONCE_CAPACITY; ++i) {
        nonce_for(nonce, i); pathnod_nonce_insert(&guard, nonce, i);
    }
    nonce_for(nonce, 0); assert(pathnod_nonce_seen(&guard, nonce, 300));
    nonce_for(nonce, 300); pathnod_nonce_insert(&guard, nonce, 301);
    nonce_for(nonce, 0); assert(pathnod_nonce_seen(&guard, nonce, 302));
    nonce_for(nonce, 1); assert(!pathnod_nonce_seen(&guard, nonce, 302));
    // Full 10-minute window at the legal maximum: every live nonce stays protected.
    memset(&guard, 0, sizeof(guard)); connection = (pathnod_connection_limit_t){0};
    for (uint32_t i = 0; i < 300; ++i) {
        nonce_for(nonce, i);
        assert(pathnod_guard_accept(&guard, &connection, nonce, (int64_t)i * 2000000) == PATHNOD_GUARD_OK);
    }
    for (uint32_t i = 0; i < 300; ++i) {
        nonce_for(nonce, i); assert(pathnod_nonce_seen(&guard, nonce, 599999999));
    }
    nonce_for(nonce, 300);
    assert(pathnod_guard_accept(&guard, &connection, nonce, 600000000) == PATHNOD_GUARD_OK);
    nonce_for(nonce, 0); assert(!pathnod_nonce_seen(&guard, nonce, 600000000));
    nonce_for(nonce, 1); assert(pathnod_nonce_seen(&guard, nonce, 600000000));
    // Replay attempts also consume quota, and cannot inflate the signing budget.
    memset(&guard, 0, sizeof(guard)); nonce_for(nonce, 9);
    for (size_t i = 0; i < 30; ++i) {
        connection = (pathnod_connection_limit_t){0};
        assert(pathnod_guard_accept(&guard, &connection, nonce, (int64_t)i) ==
            (i == 0 ? PATHNOD_GUARD_OK : PATHNOD_GUARD_REPLAY));
    }
    connection = (pathnod_connection_limit_t){0};
    assert(pathnod_guard_accept(&guard, &connection, nonce, 30) == PATHNOD_GUARD_RATE);
}

static void expect_base58(const char *text, const char *hex)
{
    uint8_t decoded[32], expected[32];
    assert(sodium_hex2bin(expected, 32, hex, 64, NULL, NULL, NULL) == 0);
    assert(pathnod_base58_decode32(text, decoded) == ESP_OK);
    assert(memcmp(decoded, expected, 32) == 0);
}

static void expect_base58_rejected(const char *text)
{
    uint8_t decoded[32];
    memset(decoded, 0xa5, sizeof(decoded));
    assert(pathnod_base58_decode32(text, decoded) != ESP_OK);
    assert(sodium_is_zero(decoded, sizeof(decoded)));
}

static void test_base58(void)
{
    // Vectors cross-checked with the bs58 npm package.
    expect_base58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9");
    expect_base58("9Hx3f9WPF5DdxqYzf51i2zieCRLTrYr5iP2b4mLmnPkd", // sdkconfig.helium
        "7b350763c0f402f77dc94d0a64a6f9c6911475cf92206035a54d7b26395dec22");
    expect_base58("11awMgzRTpb4njZ2PyZchwTtj89BUwZmeoiM2yWuA9G", // two leading zero bytes
        "0000a95eba335a104302cb62a72a9ff847e66bc57299f8315877661800e6df53");
    expect_base58("JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG", // 44 characters
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    expect_base58("11111111111111111111111111111111",
        "0000000000000000000000000000000000000000000000000000000000000000");

    expect_base58_rejected(NULL);
    expect_base58_rejected("");
    expect_base58_rejected("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofL");  // 31 bytes
    expect_base58_rejected("JJEfe6DcPM2ziB2vfUWDV6aHVerXRGkv3TcyvJUNGHZz"); // 33 bytes
    expect_base58_rejected("1TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"); // extra leading zero
    expect_base58_rejected("1111111111111111111111111111111");               // 31 zero bytes
    expect_base58_rejected("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA1"); // too long
    expect_base58_rejected("0okenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");  // '0' not in alphabet
    expect_base58_rejected("OokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect_base58_rejected("IokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect_base58_rejected("lokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect_base58_rejected(" TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect_base58_rejected("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5D\xc3\xa9");
    assert(pathnod_base58_decode32("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", NULL)
        == ESP_ERR_INVALID_ARG);
}

#if PATHNOD_TEST_REJECTED_ASSET
static void test_rejected_asset(void)
{
    pathnod_identity_t identity;
    memset(&identity, 0xa5, sizeof(identity));
    assert(pathnod_identity_init(&identity) == ESP_ERR_INVALID_ARG);
    // Refused before any identity storage is opened, created or read.
    assert(opens == 0 && sets == 0 && commits == 0);
    assert(sodium_is_zero((const unsigned char *)&identity, sizeof(identity)));
    uint8_t challenge[44] = {0}, response[78];
    assert(pathnod_identity_respond(challenge, 44, response) == ESP_ERR_INVALID_STATE);
}
#endif

int main(void)
{
#if PATHNOD_TEST_REJECTED_ASSET
    test_base58();
    test_rejected_asset();
    puts("DEV-24 rejected Helium asset test passed");
    return 0;
#endif
    test_identity();
    test_advertising();
    test_challenge_response();
    test_session_persistence_failure();
    test_counter();
    test_power_cut_snapshots();
    test_session_global_window();
    test_guard();
    test_base58();
    puts("DEV-20/21/22/24 identity, protocol, replay/rate, durable counter and hint tests passed");
    return 0;
}
