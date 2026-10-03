#pragma once
#include "esp_err.h"
#include <stdint.h>
#include <stddef.h>

#define PATHNOD_CHALLENGE_LENGTH 44
#define PATHNOD_RESPONSE_LENGTH 78
#define PATHNOD_CAPABILITIES UINT32_C(0x0000000a)
#define PATHNOD_COUNTER_RESERVATION 64

typedef struct {
    uint8_t public_key[32];
    uint8_t device_id[32];
} pathnod_identity_t;

// Call after the BLE controller starts (hardware entropy available).
// No private material is exposed by this API.
esp_err_t pathnod_identity_init(pathnod_identity_t *identity);
void pathnod_identity_info(const pathnod_identity_t *identity, uint8_t info[70]);

// Signs only SHA-256(DEV_MSG_V0), with an internally allocated durable counter.
// Timestamp/evidence remain zero. GATT must apply the boot-scoped guard first.
esp_err_t pathnod_identity_respond(const uint8_t *challenge, size_t length,
                                  uint8_t response[PATHNOD_RESPONSE_LENGTH]);
