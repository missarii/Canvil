# Authentication

## Baseline requirements

1. Passwords are hashed with a memory-hard algorithm (argon2id preferred,
   bcrypt with cost >= 12 acceptable). Never SHA-256/MD5, never unsalted.
2. Sessions are opaque random tokens (>= 128 bits) stored server-side, or
   signed tokens with short lifetimes plus a refresh mechanism.
3. Cookie attributes: `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict`), and a
   narrow `Path`.
4. Login and password-reset endpoints are rate limited per account *and* per
   IP.
5. Password reset tokens are single-use, short-lived (< 30 min), and stored
   hashed.
6. Compare secrets with a constant-time comparison.

## MFA / OTP

- 6-8 digit codes, 30-60s validity, single use, rate limited.
- Store only a hash of the code; credentials in the DB are credentials.

## OAuth / OIDC

- Use authorization code flow **with PKCE** for all clients.
- Validate the `state` parameter (CSRF) and `nonce` (replay).
- Verify `iss`, `aud`, `exp` and the signature against the provider JWKS.
- Never accept tokens issued for another client or audience.
- Implicit flow is deprecated: do not use it.

## Session invalidation

Rotate the session identifier on privilege change (login, password change) to
prevent fixation. Provide a mechanism to revoke all sessions of a user.

## Common mistakes

- Revealing whether an email exists ("user not found" vs "wrong password").
- Trusting a `role` claim from a client-supplied token without verifying the
  signature.
- Logging tokens, authorization headers or password reset URLs.
