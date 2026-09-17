# API security checklist

Derived from OWASP API Security Top 10 and the OWASP Top 10:2025 themes
(broken access control, security misconfiguration, supply-chain and injection
risks).

## Input

- Validate every field against an explicit schema (allowlist). Reject unknown
  fields or strip them.
- Enforce size limits on bodies, arrays, strings and uploads.
- Reject unexpected content types; do not parse JSON from a form body.

## Output

- Never return internal fields (`passwordHash`, `resetToken`, `deletedAt`,
  internal notes). Use explicit serializers/DTOs, not `JSON.stringify(model)`.
- Return generic messages for auth failures; log detail server-side.

## Transport and headers

- TLS everywhere; HSTS enabled.
- `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`.
- CORS: explicit origin allowlist. `*` combined with credentials is forbidden.

## Rate limiting and abuse

- Limit by identity and by IP; tighter buckets for auth, search and exports.
- Cap expensive operations (pagination must have a max page size).

## Injection

- SQL: parameterized queries only. String concatenation of user input is a bug
  even if it looks "sanitized".
- NoSQL: reject operator injection (`{$gt: ""}`) by validating types.
- OS commands: never interpolate input into a shell string; use `execFile` with
  an argument array.
- Template/HTML: escape by default; avoid `innerHTML`, `dangerouslySetInnerHTML`
  or `v-html` with user data.

## Dependencies and supply chain

- Lockfiles committed; automated vulnerability alerts enabled.
- Pin CI actions to a commit SHA, not a floating tag.
- Review install scripts of new direct dependencies.

## Error handling

- No stack traces, SQL errors or file paths in HTTP responses.
- A single global error handler maps internal errors to opaque messages.
