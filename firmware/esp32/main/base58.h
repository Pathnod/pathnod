#pragma once
#include "esp_err.h"
#include <stdint.h>

// Strict decoding of a canonical base58 (Bitcoin/Solana alphabet) string that
// encodes exactly 32 bytes, such as a Solana cNFT asset ID. Any other length,
// character or non-canonical leading '1' count is rejected; `out` is then zeroed.
esp_err_t pathnod_base58_decode32(const char *text, uint8_t out[32]);
