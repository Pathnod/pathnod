#include "advertising.h"
#include <string.h>

const uint8_t pathnod_service_uuid_le[16] = {
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x4c, 0x45, 0x56, 0x4f, 0x53
};

void pathnod_advertising_encode(const uint8_t device_id[32],
    uint8_t adv[PATHNOD_ADV_LENGTH], uint8_t scan_rsp[PATHNOD_SCAN_RSP_LENGTH])
{
    adv[0] = 2;
    adv[1] = 0x01; // Flags
    adv[2] = 0x06; // General discoverable, BR/EDR unsupported
    adv[3] = 17;
    adv[4] = 0x07; // Complete 128-bit Service UUID list
    memcpy(adv + 5, pathnod_service_uuid_le, 16);
    scan_rsp[0] = 25;
    scan_rsp[1] = 0x21; // Service Data - 128-bit UUID
    memcpy(scan_rsp + 2, pathnod_service_uuid_le, 16);
    memcpy(scan_rsp + 18, device_id, 8);
}
