#pragma once

#include <stdint.h>

// Legacy BLE splits discovery UUID and Service Data across ADV / SCAN_RSP.
#define PATHNOD_ADV_LENGTH 21
#define PATHNOD_SCAN_RSP_LENGTH 26
extern const uint8_t pathnod_service_uuid_le[16];
void pathnod_advertising_encode(const uint8_t device_id[32],
    uint8_t adv[PATHNOD_ADV_LENGTH], uint8_t scan_rsp[PATHNOD_SCAN_RSP_LENGTH]);
