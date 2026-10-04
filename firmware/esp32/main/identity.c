#include "identity.h"
#include "base58.h"
#include "sdkconfig.h"
#include "esp_flash_encrypt.h"
#include "nvs.h"
#include "sodium.h"
#include <stdbool.h>
#include <string.h>

static uint8_t signing_key[crypto_sign_SECRETKEYBYTES];
static bool signing_ready;
static uint64_t next_counter;
static uint32_t counter_ceiling;

static esp_err_t load_counter(nvs_handle_t handle)
{
    uint32_t mode = 0;
    esp_err_t mode_result = nvs_get_u32(handle, "counter_mode", &mode);
    if (mode_result != ESP_OK && mode_result != ESP_ERR_NVS_NOT_FOUND) return mode_result;
    if (mode_result == ESP_OK && mode != 1) return ESP_ERR_INVALID_STATE;
    esp_err_t result = nvs_get_u32(handle, "counter_v1", &counter_ceiling);
    if (result == ESP_ERR_NVS_NOT_FOUND) {
        // One-time migration from DEV-20/21. Once marked, a missing counter is corruption.
        if (mode_result == ESP_OK) return ESP_ERR_INVALID_STATE;
        counter_ceiling = 0;
    } else if (result != ESP_OK) return result;
    next_counter = (uint64_t)counter_ceiling + 1;
    return next_counter <= UINT32_MAX ? ESP_OK : ESP_ERR_INVALID_STATE;
}

static esp_err_t allocate_counter(uint32_t *counter)
{
    if (next_counter > UINT32_MAX) return ESP_ERR_INVALID_STATE;
    if (next_counter > counter_ceiling) {
        uint64_t ceiling = next_counter + PATHNOD_COUNTER_RESERVATION - 1;
        if (ceiling > UINT32_MAX) ceiling = UINT32_MAX;
        nvs_handle_t handle;
        esp_err_t result = nvs_open("pathnod", NVS_READWRITE, &handle);
        if (result != ESP_OK) return result;
        result = nvs_set_u32(handle, "counter_v1", (uint32_t)ceiling);
        if (result == ESP_OK) result = nvs_set_u32(handle, "counter_mode", 1);
        if (result == ESP_OK) result = nvs_commit(handle);
        nvs_close(handle);
        if (result != ESP_OK) return result;
        counter_ceiling = (uint32_t)ceiling;
    }
    *counter = (uint32_t)next_counter++;
    return ESP_OK;
}

#if CONFIG_PATHNOD_REQUIRE_ENCRYPTED_STORAGE && \
    (!CONFIG_NVS_ENCRYPTION || !CONFIG_SECURE_FLASH_ENC_ENABLED)
#error "Protected identity requires both flash encryption and NVS encryption"
#endif

esp_err_t pathnod_identity_init(pathnod_identity_t *identity)
{
    signing_ready = false;
    next_counter = 0;
    counter_ceiling = 0;
    sodium_memzero(signing_key, sizeof(signing_key));
    if (identity == NULL) return ESP_ERR_INVALID_ARG;
    sodium_memzero(identity, sizeof(*identity));
#if CONFIG_PATHNOD_REQUIRE_ENCRYPTED_STORAGE
    if (!esp_flash_encryption_enabled()) return ESP_ERR_INVALID_STATE;
#endif
    if (sodium_init() < 0) return ESP_FAIL;
#if CONFIG_PATHNOD_HELIUM_EMULATION
    // Demo only (Spec §2.6): the cNFT asset ID is fixed at build time and there
    // is no runtime path to change it. Refuse to start rather than advertise a
    // partial or zero hint, before any identity storage is touched.
    if (pathnod_base58_decode32(CONFIG_PATHNOD_HELIUM_ASSET_ID, identity->protocol_hint) != ESP_OK ||
        sodium_is_zero(identity->protocol_hint, sizeof(identity->protocol_hint))) {
        sodium_memzero(identity, sizeof(*identity));
        return ESP_ERR_INVALID_ARG;
    }
#endif
    nvs_handle_t handle;
    esp_err_t result = nvs_open("pathnod", NVS_READWRITE, &handle);
    if (result != ESP_OK) return result;

    uint8_t seed[crypto_sign_SEEDBYTES] = {0};
    uint8_t secret_key[crypto_sign_SECRETKEYBYTES] = {0};
    size_t length = sizeof(seed);
    result = nvs_get_blob(handle, "ed25519_seed", seed, &length);
    if (result == ESP_ERR_NVS_NOT_FOUND) {
        randombytes_buf(seed, sizeof(seed));
        result = nvs_set_blob(handle, "ed25519_seed", seed, sizeof(seed));
        if (result == ESP_OK) result = nvs_commit(handle);
    } else if (result == ESP_OK && length != sizeof(seed)) {
        result = ESP_ERR_INVALID_SIZE;
    }
    // Never repair/erase corrupt storage or rotate the identity automatically.
    if (result == ESP_OK) result = load_counter(handle);
    if (result == ESP_OK) {
        if (crypto_sign_seed_keypair(identity->public_key, secret_key, seed) != 0) {
            result = ESP_FAIL;
        } else {
            static const unsigned char domain[] = "Pathnod/device/v0";
            crypto_hash_sha256_state hash;
            crypto_hash_sha256_init(&hash);
            crypto_hash_sha256_update(&hash, domain, sizeof(domain) - 1);
            crypto_hash_sha256_update(&hash, identity->public_key, sizeof(identity->public_key));
            crypto_hash_sha256_final(&hash, identity->device_id);
            memcpy(signing_key, secret_key, sizeof(signing_key));
            signing_ready = true;
        }
    }
    sodium_memzero(seed, sizeof(seed));
    sodium_memzero(secret_key, sizeof(secret_key));
    nvs_close(handle);
    if (result != ESP_OK) sodium_memzero(identity, sizeof(*identity));
    return result;
}

void pathnod_identity_info(const pathnod_identity_t *identity, uint8_t info[70])
{
    memset(info, 0, 70);
    info[1] = 1; // Version 0, Ed25519.
    memcpy(info + 2, identity->public_key, 32);
    for (size_t i = 0; i < 4; ++i) info[34 + i] = (uint8_t)(PATHNOD_CAPABILITIES >> (24 - 8 * i));
    memcpy(info + 38, identity->protocol_hint, 32);
}

esp_err_t pathnod_identity_respond(const uint8_t *challenge, size_t length,
                                  uint8_t response[PATHNOD_RESPONSE_LENGTH])
{
    if (response == NULL) return ESP_ERR_INVALID_ARG;
    sodium_memzero(response, PATHNOD_RESPONSE_LENGTH);
    if (challenge == NULL || length != PATHNOD_CHALLENGE_LENGTH)
        return ESP_ERR_INVALID_ARG;
    if (!signing_ready) return ESP_ERR_INVALID_STATE;
    uint32_t counter;
    esp_err_t result = allocate_counter(&counter);
    if (result != ESP_OK) {
        // A failed commit is ambiguous: stop signing until reinitialization.
        signing_ready = false;
        sodium_memzero(signing_key, sizeof(signing_key));
        return result;
    }
    for (size_t i = 0; i < 4; ++i) response[72 + i] = (uint8_t)(counter >> (24 - 8 * i));
    // Domain is exactly 20 ASCII bytes, no NUL. Challenge bytes already contain
    // big-endian epoch/hint. No clock or evidence capability is claimed.
    uint8_t message[108] = {0}, digest[crypto_hash_sha256_BYTES];
    memcpy(message, "Pathnod/challenge/v0", 20);
    memcpy(message + 20, challenge, PATHNOD_CHALLENGE_LENGTH);
    memcpy(message + 72, response + 72, 4);
    crypto_hash_sha256(digest, message, sizeof(message));
    int rc = crypto_sign_detached(response, NULL, digest, sizeof(digest), signing_key);
    sodium_memzero(message, sizeof(message));
    sodium_memzero(digest, sizeof(digest));
    if (rc != 0) {
        sodium_memzero(response, PATHNOD_RESPONSE_LENGTH);
        return ESP_FAIL;
    }
    return ESP_OK;
}
