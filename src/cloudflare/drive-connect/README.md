# Google Drive connection relay (#4230)

This Worker signs ten-minute routing tickets and returns Google's initial authorization response to the static Maple Hosted page. It has **no Google client secret, PKCE verifier, refresh/access token, Drive API, media access, storage binding, or token-exchange route**. All exchange and renewal happen in the owner's Bun server.

## Protocol

Bun POSTs JSON `{nonce, clientId, challenge, returnUrl}` to `/api/connect/google-drive/start`. Nonce and S256 challenge are 43-character base64url strings. `returnUrl` is HTTPS (explicit loopback HTTP allowed) with the fixed path `/api/cloud-backup/google/callback`, without credentials/query/fragment. The response `{ticket, expiresAt, redirectUri}` fixes Google redirect URI to `https://mapleeditor.com/api/connect/google-drive/callback`.

Bun stores the exact signed ticket, locally constructs the Google authorization URL, and navigates to `https://mapleeditor.com/connect/google-drive?ngsw-bypass=true#<base64url UTF-8 JSON {ticket, authorizationUrl}>`. The static page validates the ticket at same-origin POST `/api/connect/google-drive/validate`, checks every Google URL parameter against the ticket, and requires pasting the bound Bun callback URL before navigation. The Worker never builds/replaces the authorization request or contacts the Bun server.

Google GETs `/api/connect/google-drive/callback?code=...&state=<ticket>`. The relay verifies the ticket and moves the code/error plus exact ticket into the canonical `/connect/google-drive/return?ngsw-bypass=true` fragment. Hosted clears the fragment before Angular initialization, validates it, and requires the user to confirm the destination. Browser navigation returns to the Bun callback with query `state=<ticket>` and `code` or `error`. Only Bun's owner-bound, cookie-bound single-use flow plus server-held verifier can exchange the code. Relay tickets alone cannot authorize a connection.

No value is written to local storage, IndexedDB, cookies or a code vault on Hosted/Worker. Reloading/closing requires starting again. Existing tokens do not depend on relay availability.

## Development and deployment

Use Node/npm (Workers Vitest pool does not support Bun's WebSocket bridge). Run `npm ci`, copy `.dev.vars.example` to `.dev.vars`, `npm run cf-typegen`, `npm run typecheck`, `npm test`. The example key is strictly for local tests. Generated runtime/secret types and development secrets are ignored.

The committed Wrangler config contains only public routes for the three exact Cloudflare zones: mapleeditor.com, maple-editor.com and mapleaperture.com. Each API pattern is more specific than the existing Hosted SSR domain route. A separate `maple-drive-connect-pages` Worker, configured by `../ssr/wrangler.drive-connect.jsonc`, fronts only `https://{host}/connect/google-drive*` on these same three zones. It runs the existing SSR security handling with observability, Logpush, preview URLs and source maps disabled. It does not change unrelated domain assignments. All three host the static routes; new Google clients register only the fixed canonical URI above. Do not redirect code-bearing API requests between aliases.

Before deploying:

1. Configure an account-scoped deployment token with Worker script + route and zone permissions for all three zones, and proxied DNS.
2. Store a cryptographically random, operator-owned `RELAY_SIGNING_KEY` with at least 32 bytes of entropy in the protected GitHub production environment as `RELAY_SIGNING_KEY`. Use the same value on subsequent deployments; rotation expires pending connections only. Never use a test key in production. This is a routing key, not a Google application credential.
3. Deploy the latest Hosted bundle to `hornbeam/mapleaperture` before enabling the relay. The protected connection deployment workflow deploys the dedicated page Worker before the relay. Disable Cloudflare Web Analytics/RUM, Zaraz, injected scripts, and request/body/header/query log collection on `/connect/google-drive*` and `/api/connect/google-drive/*` in all three zones. `no-transform` and strict CSP are additional protections; they cannot substitute for verifying zone settings.
4. Deploy both Workers via the manual protected `deploy-drive-connect.yml` workflow, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets plus that environment’s `RELAY_SIGNING_KEY` secret. It installs both packages, validates both bundles with dry runs, then deploys `maple-drive-connect-pages` with the explicit public config before `maple-drive-connect`. The relay upload uses `--secrets-file` to create its real code and key together, including the first deployment. The temporary file is exclusive and mode 0600, never logged or uploaded as an artifact, and removed even on failure. There is no empty Worker bootstrap or prior-secret lookup. No placeholder account, Google credential, or production signing key is committed.
5. Run the smoke checker against all three domains. Confirm no analytics scripts, no-store/no-referrer/CSP, API 404/405 behavior, current bundle, and callback code fragments. Real Google Web-client S256 and owner-cookie exchange remains a release gate with the Bun application.

Hosted uses the same Angular application and lazy route pages. `ngsw-bypass=true` on initial/return navigation bypasses an already controlling old Angular service worker; the updated navigation rules also exclude these pages and API routes, and these pages never register a new service worker. Validation requests carry `ngsw-bypass`.

Worker observability and source-map upload are deliberately disabled because its HTTP URLs carry initial authorization codes. Do not enable request logging or tail production callback requests. Edge/account logs require independent operator configuration; the repository cannot assert deployed settings without account credentials.

## Existing Hosted assignments

The read-only account audit on 2026-10-04 found `mapleeditor.com` and `maple-editor.com` assigned to legacy `ssr`, and `mapleaperture.com` to `maple-hosted-ssr`. Legacy source mappings, the current SSR public origin binding and the Hosted upload workflow all resolve these applications to `https://hornbeam.blob.core.windows.net/mapleaperture`. The dedicated page routes take precedence only for connection pages; deployment preserves those domain assignments and the rest of their applications.

The primary `maple-hosted-ssr` currently persists invocation logs without query-string redaction. Connection pages instead use the dedicated page Worker with logging disabled; the callback relay separately has logging disabled. This does not disable or verify zone/account collection. The local Wrangler session has Worker/route access but received permission errors reading DNS, Web Analytics/RUM, Zaraz and Logpush settings. Verify those exclusions with appropriate operator access, provision the signing key and GitHub deployment secrets, and complete actual Google Web-client S256 smoke before production rollout.
