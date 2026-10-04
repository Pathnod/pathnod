idf_component_register(SRCS "main.c" "identity.c" "advertising.c" "session.c" "guard.c"
    INCLUDE_DIRS "." REQUIRES bt nvs_flash nvs_sec_provider espressif__libsodium bootloader_support esp_timer)
