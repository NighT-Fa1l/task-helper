# Security

Task Helper v0.3 is local-first.

Current limitations:
- AI keys are browser-local, not server-side secrets.
- Google profile data is client-side.
- Calendar access is read-only.
- No backend authorization layer exists yet.

Never commit `.env`, private keys, service-account files, or shared AI credentials.

Before centralizing user data, add server-side session verification, database RLS, encrypted credentials, input validation and rate limiting.
