#include "session.h"
#include <string.h>

void pathnod_session_reset(pathnod_session_t *session)
{
    memset(session, 0, sizeof(*session));
}

void pathnod_session_connect(pathnod_session_t *session, uint16_t connection)
{
    pathnod_session_reset(session);
    session->connected = true;
    session->connection = connection;
}

bool pathnod_session_matches(const pathnod_session_t *session, uint16_t connection)
{
    return session->connected && session->connection == connection;
}

esp_err_t pathnod_session_challenge(pathnod_session_t *session, uint16_t connection,
                                   const uint8_t *challenge, size_t length)
{
    if (!pathnod_session_matches(session, connection)) return ESP_ERR_INVALID_STATE;
    session->valid = false;
    memset(session->response, 0, sizeof(session->response));
    esp_err_t result = pathnod_identity_respond(challenge, length, session->response);
    session->valid = result == ESP_OK;
    return result;
}
