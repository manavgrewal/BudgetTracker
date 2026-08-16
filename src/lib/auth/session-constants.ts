/** Edge-runtime safe: no database, no Node-only imports. */
export const SESSION_COOKIE_NAME = 'bt_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Only rewrite expires_at when the session has not been touched for this long. */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
