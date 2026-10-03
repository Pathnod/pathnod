#pragma once
#include "esp_err.h"
#include <stdint.h>
#include <stddef.h>

#define PATHNOD_CHALLENGE_LENGTH 44
#define PATHNOD_RESPONSE_LENGTH 78

typedef struct {
    uint8_t public_key[32];
    uint8_t device_id[32];
} pathnod_identity_t;

// Call after the BLE controller starts (hardware entropy available).
// No private material is exposed by this API.
esp_err_t pathnod_identity_init(pathnod_identity_t *identity);

// Signs only SHA-256(DEV_MSG_V0); timestamp/counter/evidence remain zero.
esp_err_t pathnod_identity_respond(const uint8_t *challenge, size_t length,
                                  uint8_t response[PATHNOD_RESPONSE_LENGTH]);
