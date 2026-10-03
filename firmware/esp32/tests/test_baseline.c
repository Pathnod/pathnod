#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sodium.h>
#include "identity.h"
#include "advertising.h"
#include "nvs.h"
#include "sdkconfig.h"
#include "session.h"

static uint8_t stored_seed[32];
static bool exists, encrypted = true;
static size_t stored_length = 32;
static int sets, commits, opens, closes;
static esp_err_t open_error, read_error, write_error, commit_error;

bool esp_flash_encryption_enabled(void) { return encrypted; }
esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle)
{
    assert(strcmp(name, "pathnod") == 0 && mode == NVS_READWRITE);
    opens++;
    *handle = 1;
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
esp_err_t nvs_commit(nvs_handle_t handle) { assert(handle == 1); commits++; return commit_error; }
void nvs_close(nvs_handle_t handle) { assert(handle == 1); closes++; }

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
    assert(pathnod_identity_respond(challenge, 44, response) == ESP_OK);
    // Independent Node.js/OpenSSL Ed25519 vector (public test seed 00..1f).
    uint8_t expected_signature[64];
    assert(sodium_hex2bin(expected_signature, 64,
        "dceadd957da380f4ef5217e8e336c5d3840587b0662a576d5ddc68324d4c64c37"
        "ca514895d6ec6f94fca7d727beb03a7a039e0e5bfbadf3e51c3437b31841405",
        128, NULL, NULL, NULL) == 0);
    assert(memcmp(response, expected_signature, sizeof(expected_signature)) == 0);
    // Independent layout: 20 domain + nonce32 + epoch4 + hint8 + ts8 +
    // counter4 + evidence_hash32. Signing the raw message must NOT verify.
    uint8_t message[108] = {0};
    memcpy(message, "Pathnod/challenge/v0", 20);
    memcpy(message + 20, challenge, 44);
    crypto_hash_sha256(digest, message, sizeof(message));
    assert(crypto_sign_verify_detached(response, digest, 32, identity.public_key) == 0);
    assert(crypto_sign_verify_detached(response, message, 108, identity.public_key) != 0);
    for (size_t i = 64; i < 78; ++i) assert(response[i] == 0);
    for (size_t i = 20; i < 108; ++i) {
        message[i] ^= 1;
        crypto_hash_sha256(digest, message, sizeof(message));
        assert(crypto_sign_verify_detached(response, digest, 32, identity.public_key) != 0);
        message[i] ^= 1;
    }
    pathnod_session_t session;
    pathnod_session_reset(&session);
    assert(pathnod_session_challenge(&session, 7, challenge, 44) == ESP_ERR_INVALID_STATE);
    pathnod_session_connect(&session, 7);
    assert(pathnod_session_challenge(&session, 8, challenge, 44) == ESP_ERR_INVALID_STATE);
    assert(pathnod_session_challenge(&session, 7, challenge, 44) == ESP_OK && session.valid);
    for (size_t length = 0; length <= 45; ++length) {
        if (length == 44) continue;
        assert(pathnod_session_challenge(&session, 7, challenge, length) == ESP_ERR_INVALID_ARG);
        assert(!session.valid);
        for (size_t i = 0; i < 78; ++i) assert(session.response[i] == 0);
    }
    assert(pathnod_session_challenge(&session, 7, NULL, 44) == ESP_ERR_INVALID_ARG);
    assert(pathnod_identity_respond(challenge, 44, NULL) == ESP_ERR_INVALID_ARG);
    assert(pathnod_session_challenge(&session, 7, challenge, 44) == ESP_OK);
    session.subscribed = true;
    pathnod_session_connect(&session, 7); // Reused connection handle is a new session.
    assert(!session.valid && !session.subscribed);
    pathnod_session_reset(&session);
    assert(!pathnod_session_matches(&session, 7));
    open_error = ESP_FAIL;
    assert(pathnod_identity_init(&identity) == ESP_FAIL);
    assert(pathnod_identity_respond(challenge, 44, response) == ESP_ERR_INVALID_STATE);
}

int main(void)
{
    test_identity();
    test_advertising();
    test_challenge_response();
    puts("DEV-20/21 identity, advertising and challenge/response tests passed");
    return 0;
}
