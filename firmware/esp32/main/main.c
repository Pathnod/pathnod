#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "nvs_flash.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "identity.h"
#include "advertising.h"

static const char *TAG = "pathnod";
static pathnod_identity_t identity;
static uint8_t address_type;
static const ble_uuid128_t service_uuid = BLE_UUID128_INIT(
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x4c, 0x45, 0x56, 0x4f, 0x53);
static const ble_uuid128_t info_uuid = BLE_UUID128_INIT(
    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x4c, 0x45, 0x56, 0x4f, 0x53);

// Public identity inspection only. CHALLENGE/RESPONSE belong to DEV-21.
static int info_read(uint16_t conn, uint16_t attr,
                     struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn; (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
    uint8_t info[70] = {0, 1}; // v0, Ed25519; no capabilities promised yet
    memcpy(info + 2, identity.public_key, sizeof(identity.public_key));
    return os_mbuf_append(ctxt->om, info, sizeof(info)) == 0
        ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static const struct ble_gatt_chr_def characteristics[] = {
    {.uuid = &info_uuid.u, .access_cb = info_read, .flags = BLE_GATT_CHR_F_READ},
    {0}
};
static const struct ble_gatt_svc_def services[] = {
    {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &service_uuid.u,
     .characteristics = characteristics},
    {0}
};

static void advertise(void);
static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status != 0) advertise();
        break;
    case BLE_GAP_EVENT_DISCONNECT:
    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        break;
    default:
        break;
    }
    return 0;
}

static void advertise(void)
{
    uint8_t adv[PATHNOD_ADV_LENGTH], scan_rsp[PATHNOD_SCAN_RSP_LENGTH];
    pathnod_advertising_encode(identity.device_id, adv, scan_rsp);
    int rc = ble_gap_adv_set_data(adv, sizeof(adv));
    if (rc == 0) rc = ble_gap_adv_rsp_set_data(scan_rsp, sizeof(scan_rsp));
    struct ble_gap_adv_params params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
        .itvl_min = 1600, .itvl_max = 1600 // 1000 ms / 0.625 ms
    };
    if (rc == 0) rc = ble_gap_adv_start(address_type, NULL, BLE_HS_FOREVER,
                                      &params, gap_event, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "Advertising failed (%d)", rc);
        abort();
    }
    ESP_LOGI(TAG, "Advertising Pathnod UUID (1 s interval)");
}

static void on_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    if (rc == 0) rc = ble_hs_id_infer_auto(0, &address_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "BLE address setup failed (%d)", rc);
        abort();
    }
    advertise();
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "BLE host reset (%d); waiting for synchronization", reason);
}

static void host_task(void *arg)
{
    (void)arg;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void app_main(void)
{
    // Deliberately no nvs_flash_erase() fallback: that would destroy identity.
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(nimble_port_init());
    ESP_ERROR_CHECK(pathnod_identity_init(&identity));
#if CONFIG_PATHNOD_REQUIRE_ENCRYPTED_STORAGE
    ESP_LOGI(TAG, "Identity loaded with flash and NVS encryption required");
#else
    ESP_LOGW(TAG, "DEVELOPMENT: identity storage is not hardware protected");
#endif
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ESP_ERROR_CHECK(ble_svc_gap_device_name_set("Pathnod"));
    ESP_ERROR_CHECK(ble_gatts_count_cfg(services));
    ESP_ERROR_CHECK(ble_gatts_add_svcs(services));
    nimble_port_freertos_init(host_task);
}
