#pragma once
#include "esp_err.h"
#include <stdint.h>

typedef struct {
    uint8_t public_key[32];
    uint8_t device_id[32];
} pathnod_identity_t;

// Call after the BLE controller starts (hardware entropy available).
// No private material is exposed by this API.
esp_err_t pathnod_identity_init(pathnod_identity_t *identity);
