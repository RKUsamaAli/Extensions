'use strict';
/**
 * HttpError carries the status, the machine code the clients switch on (see docs/API.md)
 * and optional extra fields that are copied into the JSON body.
 */
class HttpError extends Error {
    constructor(status, code, message, extra = {}) {
        super(message || code);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

const E = {
    validation: (fields, message = 'Please check the highlighted fields.') => new HttpError(400, 'validation_error', message, { fields }),
    badRequest: (message) => new HttpError(400, 'validation_error', message, { fields: {} }),
    notSignedIn: () => new HttpError(401, 'not_signed_in', 'Please sign in.'),
    invalidCredentials: () => new HttpError(401, 'invalid_credentials', 'Wrong username or password.'),
    accessExpired: () => new HttpError(401, 'access_token_expired', 'Access token expired.'),
    sessionExpired: () => new HttpError(401, 'session_expired', 'Your sign-in has expired. Please sign in again.'),
    disabled: () => new HttpError(403, 'account_disabled', 'This account is disabled.'),
    pending: () => new HttpError(403, 'account_pending', 'This account is waiting for admin approval.'),
    noEntitlement: (ext) => new HttpError(403, 'no_entitlement', `Your account has no access to ${ext}.`, { ext }),
    expired: (ext, expiresAt) =>
        new HttpError(403, 'subscription_expired', `Your access to ${ext} expired on ${new Date(expiresAt).toISOString().slice(0, 10)}.`, { ext, expiresAt }),
    deviceLimit: (maxDevices) =>
        new HttpError(403, 'device_limit', `Device limit reached (${maxDevices}). Ask the admin to remove a device.`, { maxDevices }),
    deviceRevoked: () => new HttpError(403, 'device_revoked', 'This device was removed from your account.'),
    forbidden: (message = 'You are not allowed to do this.') => new HttpError(403, 'forbidden', message),
    notFound: (message = 'Not found.') => new HttpError(404, 'not_found', message),
    conflict: (message) => new HttpError(409, 'conflict', message),
    updateRequired: (minVersion) => new HttpError(426, 'update_required', `Please update the extension to version ${minVersion} or newer.`, { minVersion }),
    tooMany: (retryAfter) => new HttpError(429, 'too_many_requests', 'Too many requests. Please wait and try again.', { retryAfter }),
    extDisabled: (ext) => new HttpError(503, 'ext_disabled', `${ext} is switched off by the admin.`, { ext })
};

module.exports = { HttpError, E };
