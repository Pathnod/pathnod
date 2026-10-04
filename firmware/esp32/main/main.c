#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "identity.h"
#include "advertising.h"
#include "session.h"

#if CONFIG_BT_NIMBLE_MAX_CONNECTIONS != 1
#error "Pathnod GATT session currently requires exactly one BLE connection"
#endif

static const char *TAG = "pathnod";
static pathnod_identity_t identity;
static uint8_t address_type;
static pathnod_session_t session;
static pathnod_guard_t guard;
static uint16_t response_handle;
static const ble_uuid128_t service_uuid = BLE_UUID128_INIT(
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x4c, 0x45, 0x56, 0x4f, 0x53);
static const ble_uuid128_t info_uuid = BLE_UUID128_INIT(
    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x4c, 0x45, 0x56, 0x4f, 0x53);

static const ble_uuid128_t challenge_uuid = BLE_UUID128_INIT(
    3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x4c, 0x45, 0x56, 0x4f, 0x53);
static const ble_uuid128_t response_uuid = BLE_UUID128_INIT(
    4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x4c, 0x45, 0x56, 0x4f, 0x53);

static int info_read(uint16_t conn, uint16_t attr,
                     struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn; (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
    uint8_t info[70];
    pathnod_identity_info(&identity, info);
    return os_mbuf_append(ctxt->om, info, sizeof(info)) == 0
        ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int response_read(uint16_t conn, uint16_t attr,
                         struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
    if (!pathnod_session_matches(&session, conn) || !session.valid)
        return BLE_ATT_ERR_UNLIKELY;
    return os_mbuf_append(ctxt->om, session.response, sizeof(session.response)) == 0
        ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int challenge_write(uint16_t conn, uint16_t attr,
                           struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    if (!pathnod_session_matches(&session, conn)) return BLE_ATT_ERR_UNLIKELY;
    int64_t start = esp_timer_get_time();
    // NimBLE assembles and validates ATT Prepare/Execute writes before this
    // callback. Never sign partial values or retain a previous response on error.
    session.valid = false;
    memset(session.response, 0, sizeof(session.response));
    uint8_t challenge[PATHNOD_CHALLENGE_LENGTH];
    uint16_t length = 0;
    if (OS_MBUF_PKTLEN(ctxt->om) != sizeof(challenge))
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    if (ble_hs_mbuf_to_flat(ctxt->om, challenge, sizeof(challenge), &length) != 0)
        return BLE_ATT_ERR_UNLIKELY;
    if (pathnod_session_challenge(&session, conn, challenge, length, &guard, start) != ESP_OK)
        return BLE_ATT_ERR_UNLIKELY;
    if (session.subscribed) {
        uint16_t mtu = ble_att_mtu(conn);
        if (mtu < 23) return BLE_ATT_ERR_UNLIKELY;
        size_t notify_length = sizeof(session.response);
        if (notify_length > (size_t)(mtu - 3)) notify_length = mtu - 3;
        struct os_mbuf *om = ble_hs_mbuf_from_flat(session.response, notify_length);
        if (om == NULL) return BLE_ATT_ERR_INSUFFICIENT_RES;
        // Ownership transfers even on failure. The full response remains readable.
        int rc = ble_gatts_notify_custom(conn, response_handle, om);
        if (rc != 0) {
            ESP_LOGW(TAG, "Response notification enqueue failed (%d); read available", rc);
            return BLE_ATT_ERR_INSUFFICIENT_RES;
        }
    }
    int64_t elapsed = esp_timer_get_time() - start;
    // Nano printf omits 64-bit formats. Clamp diagnostics, not protocol counters.
    uint32_t elapsed_us = elapsed > UINT32_MAX ? UINT32_MAX : (uint32_t)elapsed;
    ESP_LOGI(TAG, "Challenge processing + notification enqueue: %u us", (unsigned)elapsed_us);
    if (elapsed >= 50000) ESP_LOGW(TAG, "DEV-21 50 ms processing target exceeded");
    return 0;
}

static const struct ble_gatt_chr_def characteristics[] = {
    {.uuid = &info_uuid.u, .access_cb = info_read, .flags = BLE_GATT_CHR_F_READ},
    {.uuid = &challenge_uuid.u, .access_cb = challenge_write, .flags = BLE_GATT_CHR_F_WRITE},
    {.uuid = &response_uuid.u, .access_cb = response_read,
     .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY, .val_handle = &response_handle},
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
        else pathnod_session_connect(&session, event->connect.conn_handle);
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        pathnod_session_reset(&session);
        advertise();
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (pathnod_session_matches(&session, event->subscribe.conn_handle) &&
            event->subscribe.attr_handle == response_handle)
            session.subscribed = event->subscribe.cur_notify;
        break;
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
    pathnod_session_reset(&session);
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
    ESP_LOGI(TAG, "Guard: %u nonces, %u RAM bytes; durable counter blocks of %u",
             (unsigned)PATHNOD_NONCE_CAPACITY, (unsigned)sizeof(guard),
             (unsigned)PATHNOD_COUNTER_RESERVATION);
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
