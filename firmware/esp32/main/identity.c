#include "identity.h"
#include "sdkconfig.h"
#include "esp_flash_encrypt.h"
#include "nvs.h"
#include "sodium.h"

#if CONFIG_PATHNOD_REQUIRE_ENCRYPTED_STORAGE && \
    (!CONFIG_NVS_ENCRYPTION || !CONFIG_SECURE_FLASH_ENC_ENABLED)
#error "Protected identity requires both flash encryption and NVS encryption"
#endif

esp_err_t pathnod_identity_init(pathnod_identity_t *identity)
{
    if (identity == NULL) return ESP_ERR_INVALID_ARG;
    sodium_memzero(identity, sizeof(*identity));
#if CONFIG_PATHNOD_REQUIRE_ENCRYPTED_STORAGE
    if (!esp_flash_encryption_enabled()) return ESP_ERR_INVALID_STATE;
#endif
    if (sodium_init() < 0) return ESP_FAIL;
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
        }
    }
    sodium_memzero(seed, sizeof(seed));
    sodium_memzero(secret_key, sizeof(secret_key));
    nvs_close(handle);
    if (result != ESP_OK) sodium_memzero(identity, sizeof(*identity));
    return result;
}
