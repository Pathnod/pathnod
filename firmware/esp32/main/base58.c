#include "base58.h"
#include <stdbool.h>
#include <string.h>

static int digit(char c)
{
    static const char alphabet[] =
        "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const char *found = c == '\0' ? NULL : strchr(alphabet, c);
    return found == NULL ? -1 : (int)(found - alphabet);
}

esp_err_t pathnod_base58_decode32(const char *text, uint8_t out[32])
{
    if (out == NULL) return ESP_ERR_INVALID_ARG;
    memset(out, 0, 32);
    if (text == NULL) return ESP_ERR_INVALID_ARG;
    size_t length = strlen(text);
    // 32 bytes encode to at most 44 characters.
    if (length == 0 || length > 44) return ESP_ERR_INVALID_SIZE;
    uint8_t value[32] = {0};
    size_t zeros = 0;
    bool leading = true;
    for (size_t i = 0; i < length; ++i) {
        int d = digit(text[i]);
        if (d < 0) return ESP_ERR_INVALID_ARG;
        if (leading && d == 0) {
            zeros++; // Each leading '1' is one leading zero byte.
            continue;
        }
        leading = false;
        uint32_t carry = (uint32_t)d;
        for (size_t j = 32; j-- > 0;) {
            carry += (uint32_t)value[j] * 58;
            value[j] = (uint8_t)carry;
            carry >>= 8;
        }
        if (carry != 0) return ESP_ERR_INVALID_SIZE;
    }
    size_t unused = 0;
    while (unused < 32 && value[unused] == 0) unused++;
    // Canonical encoding: leading '1's account for exactly the leading zero bytes.
    if (zeros + (32 - unused) != 32) return ESP_ERR_INVALID_SIZE;
    memcpy(out, value, 32);
    return ESP_OK;
}
