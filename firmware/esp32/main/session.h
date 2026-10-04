#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "identity.h"

typedef struct {
    bool connected, subscribed, valid;
    uint16_t connection;
    uint8_t response[PATHNOD_RESPONSE_LENGTH];
} pathnod_session_t;

void pathnod_session_reset(pathnod_session_t *session);
void pathnod_session_connect(pathnod_session_t *session, uint16_t connection);
bool pathnod_session_matches(const pathnod_session_t *session, uint16_t connection);
esp_err_t pathnod_session_challenge(pathnod_session_t *session, uint16_t connection,
                                   const uint8_t *challenge, size_t length);
