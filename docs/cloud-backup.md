# Self Hosted backups and recovery

Settings → Backup manages destinations for each registered library. Folder destinations use Maple's existing filesystem mirrors. Google Drive destinations store verified, immutable photo versions and a portable recovery catalog in a dedicated, visible My Drive folder. Google Drive is the only implemented cloud provider; OneDrive, Dropbox, S3 and Azure are not available destinations.

Backup covers indexed originals, their paired XMP sidecars, the recorded Apple rendered companion, hidden state, and Trash metadata. XMP bytes are preserved without rewriting unknown XML. Thumbnail and preview caches, unindexed files, user accounts, server settings and the whole SQLite database are outside this photo recovery format. Keep a separate server/database backup.

The implementation lives in `src/api/src/cloud-backup/`, `src/api/src/routes/cloud-backup.ts`, `src/api/src/routes/cloud-backup-google.ts`, and `src/api/src/workers/stages/cloud-backup.ts`. The Self Hosted controls are in `src/web/projects/maple/src/app/settings/backup/`.

## Google application setup

An owner supplies their own Google **Web application** OAuth client ID and client secret. The Maple application option is unavailable: the implementation does not distribute a shared confidential Google client secret. The optional relay also uses the owner's Web client. A Desktop client with an arbitrary HTTPS relay redirect is not this flow.

1. Create a Google Cloud project, enable the Google Drive API, configure its OAuth consent screen, and create a Web application OAuth client. Use a dedicated client for Maple.
2. Request only `https://www.googleapis.com/auth/drive.file`. Maple rejects a token with additional scopes or a different client identity.
3. In Maple's Network settings, set the canonical browser-facing origin, for example `https://photos.example.com`. The explicit public origin takes precedence over the configured managed HTTPS hostname and port. Use the same origin when opening Maple to connect Drive.
4. Add a Google Drive destination under Backup, check **Bring your own client ID**, and enter the ID and secret. An empty secret field preserves the saved secret; clearing credentials explicitly removes it. Saved secrets are never returned to the browser.
5. Choose direct callback or hosted relay, register the corresponding Google redirect URI below, save, then connect. Complete the flow in the same browser within ten minutes.
6. Explicitly create the backup folder, or attach an existing Maple backup root ID. Enable the destination. In Workers settings, resume the `cloud-backup` stage if it is paused; its first-boot default is paused.

Google's `drive.file` scope covers files created or explicitly opened with the application. It does not authorize browsing the user's entire Drive. This scope is a per-file grant, rather than a Google-enforced sandbox around one folder; Maple additionally validates its configured root and each object's current parent before access or removal. [Google's Drive scope documentation](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

For an external consent screen left in **Testing**, Google issues Drive refresh tokens that expire after seven days. Configure the appropriate production or organization-internal publishing state for unattended operation. Production tokens can still stop working after revocation, token limits, inactivity or administrator policy changes. Maple then requires reconnection; it cannot promise permanent authorization. [Google's refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

### Callback pairing

Both flows finish at the same Bun-served endpoint. The Google redirect differs:

| Mode         | Register this exact authorized redirect URI in Google         | Bun callback shown in Maple                                   |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Direct       | `https://photos.example.com/api/cloud-backup/google/callback` | `https://photos.example.com/api/cloud-backup/google/callback` |
| Hosted relay | `https://mapleeditor.com/api/connect/google-drive/callback`   | `https://photos.example.com/api/cloud-backup/google/callback` |

Replace the example origin with the one configured in Network settings. Scheme, host, port and path must match; do not add a trailing slash. Google's Web application redirect validation requires HTTPS except for permitted localhost development redirects. [Google's Web OAuth documentation](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation).

For the relay flow, copy the **Bun callback URL** displayed in Maple and paste it into the hosted connection page when prompted. Do not paste the relay callback into that field. The hosted page verifies the pasted address against the signed request and asks for confirmation before returning to your instance.

The browser must resolve and reach the instance's configured origin. A private HTTPS hostname can therefore work with the relay; the Worker never fetches the NAS or local server. Plain HTTP LAN addresses are rejected. HTTP loopback is supported only for local development: `localhost` in the browser refers to the browser's machine. Direct mode also applies Google's public-host redirect restrictions. Use an HTTPS origin without a path prefix, query or fragment.

TLS may terminate at a reverse proxy while Bun receives internal HTTP. Configure the external origin in Network settings and preserve the normal browser cookie flow; Maple does not derive the OAuth authority from forwarded headers. Changing the origin, credentials or callback mode during a pending flow invalidates it. Start a new connection after such changes.

### Existing root and credentials

The root must be a Maple-created, owned My Drive folder with its original marker. Root attachment checks the authenticated Google account and folder identity. It does not select an arbitrary preexisting Drive folder or request broader access.

Record the root ID and keep the Google project/client credentials separately from the Maple database. Fresh-server recovery reconnects the same account and attaches that root before reading its remote catalog. An existing root can contain library IDs from an older database; recovery reads those portable catalog records rather than requiring the new database's library ID to match.

Using another Google project/client does not automatically grant access to files created by the previous application. Reconnect using the original client and account. An inaccessible root is reported as a failure; Maple does not silently create a replacement and claim the old backup is connected.

Once a destination has a root, use another destination for a different root. Its existing upload identities and deletion obligations remain bound to the original root. Attaching an old root to a fresh destination with no root is supported.

Disconnect removes local authorization and prevents further backup use. It preserves remote files and outstanding purge obligations. Clearing credentials also removes the saved application credentials. Neither action erases the backup nor substitutes for revoking consent in the Google account. Rotating Maple's server JWT bootstrap key makes its locally encrypted Drive credentials unreadable and requires reconnection.

## Trust and hosted infrastructure

Bun generates the PKCE verifier and stores the single-use pending flow locally. Both direct and relay flows exchange the authorization code and refresh tokens directly with Google's fixed token endpoint. The local database encrypts the client secret, refresh token and pending sensitive material with an AES-GCM key derived from Maple's existing server secret. The database also contains that bootstrap secret, so protect the database file, its backups and the host; encryption is not protection against a complete database compromise.

The hosted relay receives routing metadata and the initial Google authorization code. It has no Google client secret, PKCE verifier, refresh/access token, media endpoint, token-exchange endpoint or code storage. The Hosted pages use transient memory and clear code-bearing fragments before Angular initialization. Bun additionally requires the initiating owner's identity, its dedicated HttpOnly flow cookie, the exact stored state and the server-held verifier. Confirm Google enforces S256 with the actual Web client before releasing the relay; unit tests are not evidence of a live provider configuration.

Google holds the uploaded photo bytes. Maple's hosted operator does not receive the credentials needed to read those bytes through this architecture. A compromised local Maple server or Google account remains able to access its authorized backup.

The hosted deployment comprises these routes:

| Component                                 | Routes                                                                                                                      | Source                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Existing Maple Hosted Angular application | `/connect/google-drive`, `/connect/google-drive/return`                                                                     | `src/web/projects/maple-syrup/src/app/connect/` |
| Connection Worker                         | `POST /api/connect/google-drive/start`, `POST /api/connect/google-drive/validate`, `GET /api/connect/google-drive/callback` | `src/cloudflare/drive-connect/`                 |
| Self Hosted Bun server                    | `/api/cloud-backup/google/callback`                                                                                         | `src/api/src/routes/cloud-backup-google.ts`     |

The Hosted deployment targets are `mapleeditor.com`, `maple-editor.com` and `mapleaperture.com`. The committed relay Worker config assigns only `/api/connect/google-drive/*` in those three Cloudflare zones, ahead of their broader Hosted SSR routes. A dedicated `maple-drive-connect-pages` Worker uses `src/cloudflare/ssr/wrangler.drive-connect.jsonc` to serve only `/connect/google-drive*` on all three domains with logging, Logpush, source maps and preview URLs disabled. New connections always use the canonical `mapleeditor.com` Google redirect URI. Do not redirect code-bearing API requests between domain aliases.

The operator must provide Cloudflare account credentials, proxied DNS and Worker/route permissions for all three zones; store a random production `RELAY_SIGNING_KEY` with at least 32 bytes of entropy in the protected GitHub production environment; and supply `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `RELAY_SIGNING_KEY` to the manual `.github/workflows/deploy-drive-connect.yml` workflow. The workflow passes the routing key in a private temporary secrets file with the first real relay upload, removes the file even on failure, and reuses the supplied key on later deployments. It does not require an empty bootstrap Worker or a preexisting Cloudflare secret. The signing key is routing authority, not a Google credential. Rotation expires pending connections only. Hosted deployment uses the existing Azure deployment workflow and its `AZURE_CREDENTIALS`; deploy the current Hosted bundle to `hornbeam/mapleaperture` before enabling the connection Workers. The protected connection workflow validates both bundles and deploys the dedicated page Worker before the callback relay. It preserves the existing custom-domain assignments (`ssr` for the two mapleeditor aliases and `maple-hosted-ssr` for mapleaperture); only the narrow connection page/API routes take precedence.

Disable injected analytics/RUM, Zaraz, scripts and request/body/header/query logging on `/connect/google-drive*` and `/api/connect/google-drive/*` in all three zones. The code supplies no-store, no-referrer and restrictive CSP policies and disables Worker observability; external account and edge logging still require operator configuration. Do not tail callback requests. Self Hosted reverse proxies also need to exclude the Bun callback query from access logs. The `ngsw-bypass=true` navigation flag handles browsers with an older controlling Angular service worker.

See `src/cloudflare/drive-connect/README.md` for deployment and smoke-check commands. Production account credentials, zone settings, deployed behavior and a live Google connection must be verified separately; local tests do not establish those facts. Existing backups and token refresh continue if the relay becomes unavailable, while new relay connections cannot start.

## Backup behavior and coverage

Google uploads run through the shared asset-stage scheduler. Each destination tracks its own success, retry state and current generation. A failed target does not prevent another target from completing. Credentials, root changes, Trash transitions and explicit purges fence stale work. Resumable uploads persist their reserved file IDs and checkpoints before use and after each chunk, so retries can reconcile lost responses without publishing duplicate versions.

The cloud catalog uses ordinary downloadable JSON objects and SHA-256-addressed blobs under `libraries/<libraryId>/entries/<entryId>/`. Immutable manifests record the version sequence, current/original paths, hidden state, Trash timestamp and exact file identities. Original filenames and content types are display metadata; they do not change immutable logical keys. New XMP versions can reuse a verified original blob within the same entry. A version becomes verified only after its complete file set and manifest are checked. A filename or embedded marker alone is not proof of matching bytes.

Google objects also carry a public `mapleKeyHash` property for exact logical-key searches. Known locators are validated directly, and catalog listings retain full portable keys in ordinary description metadata without depending on that search property. The property is a lookup index, not an integrity guarantee. [Google's public custom-property and size-limit documentation](https://developers.google.com/workspace/drive/api/guides/properties).

Backup status describes admitted indexed assets. It does not imply the source library is complete, that unindexed or unavailable files were protected, or that every previous edit version exists. Keep the primary source available until coverage and failures have been reviewed. Retries preserve old verified cloud versions; restoring a historical version uses its recorded immutable file set.

Folder destinations continue to use the existing mirror writer and scan/copy/scrub maintenance. Creating a folder destination does not retroactively prove all older files have been copied and verified. Reconcile with the existing mirror maintenance and inspect its queue/errors and actual files before relying on it. The Google catalog/recovery UI is not a catalog for local folder mirrors, and folder destination counters are not a full historical coverage certificate. Changing a folder root requires a new destination, so pending deletion obligations retain their original root.

## Trash, purge and blocked cleanup

Moving a photo to Maple Trash keeps backup bytes and publishes its Trash state. Restoring from Trash publishes active state again. Cloud recovery can include Trash and preserves its actual `.maple/trash/` path, original path, hidden state and original deletion timestamp; it does not reset the retention clock or create an active alias over another photo.

Trash moves have a durable owner and renewable lease shared by the HTTP and background processes. Verified copies are committed to the catalog before their sources are removed; a lost lease or failed catalog write retains the source. A watcher identity with backup history cannot be silently discarded during restore. Maple can choose the next free restore name when that identity still occupies the requested catalog path.

Replacing an upload uses the same Trash workflow. Redundant-copy cleanup requires complete byte identity and a single unchanged location; any XMP or recorded Apple companion keeps the old identity in Trash. Merging deduplicated asset rows preserves their stable backup history and fences old transfer owners.

Permanent deletion and retention expiry of intentionally trashed photos first record a durable intent in SQLite before local bytes and the asset row disappear. Cloud cleanup first publishes `purges/<entryId>.json`, then removes that entry's versions, blobs and unfinished uploads. Recovery excludes a published purged entry even if physical cleanup is incomplete. Local mirrors keep exact-path and byte-identity obligations, so a newer file reused at an old Trash path is not deliberately removed as the previous photo.

Google cleanup shares two streaming root inventories across each pending purge batch. Persisted object identities and upload reservations remain separate obligations, so moved files and interrupted uploads cannot disappear from tracking just because the root listing omits them.

Purge admission checks the selected deletion timestamp, reason, locations and companion association in that same transaction. Retention skips changed candidates and continues; an explicit deletion returns HTTP 409 so the owner can refresh the Trash view. A photo restored after selection keeps its files and cloud history.

Photos marked reaped because all indexed locations are missing keep their catalog rows when an existing destination has backup entries or a configured folder mirror covers a recorded location, even after the local retention window expires. Paused mirrors also retain their tracking. This skip is logged and counted as scanned without a purge or error. Only explicit permanent deletion authorizes erasing their backups; a returned original or sidecar at the stored location remains untouched. Reaped rows without configured backups retain the existing database-only cleanup behavior.

Explicit purge inventories mirrored originals, XMPs and recorded companions from the retained locations, including missing sources. A reaped or missing location requires an available mirror and full byte identity from retained manifests or an available source. Older folder mirrors do not retain a full hash for every copy: if the source and verified identity are both gone, Maple keeps the row and requests retry. Reconnect the source/mirror, or manually verify and remove the retained mirror copy before retrying. Hashing an unknown mirror file alone cannot prove it belongs to the missing photo.

Offline, disabled or disconnected targets can still owe erasure. A disconnected target cannot fulfill it until the owner reconnects. The destination cannot be removed while its purge or transfer obligations remain open. A pending purge is not a statement that every remote byte has already been erased.

Removing an otherwise idle destination leaves its remote files intact and ends Maple's tracking of that copy. Later primary-library deletions will no longer propagate there. Review or remove the retained backup separately before discarding its credentials or root ID; adding it again cannot reconstruct local deletion intents that were never recorded for that destination.

Destination removal atomically clears its local credentials, entries, object mappings, upload checkpoints and completed purge records. Pending erasure or active transfers block removal; stale workers cannot admit new work for a removed destination.

Preserve the original SQLite database while purges are pending. Until a tombstone reaches the remote root, an offline purge intent exists only in that local ledger. If the database is lost before publication, fresh-server recovery cannot infer that intent from the older backup alone. After publication, the portable remote purge journal suppresses recovery independently of the original database.

A missing mount, missing source file, failed scan or removed database asset row does not authorize cloud deletion. Maple requires an explicit recorded lifecycle intent.

Do not move backup objects out of their configured root, edit their contents/identity metadata, or transfer ownership. The adapter refuses download/removal outside the root; persisted object IDs remain pending erasure obligations rather than being silently forgotten. Root deletion, Trash placement, lost ownership or moving it into an unsupported shared drive also blocks work. Renaming or moving an otherwise valid owned root within My Drive retains its ID. Restore the required root/object relationship and retry, or investigate and resolve the remote state manually. Never mark blocked cleanup complete solely because a root-scoped listing no longer sees a moved object.

## Recovering photos

1. On the existing or replacement Self Hosted server, configure the original Web client, connect the same Google account and attach the original backup root ID.
2. Review the remote catalog. Choose the latest active versions, include Trash when needed, or select an entry's historical sequence.
3. Choose an existing **empty** recovery directory within the server's allowed roots, with enough free disk space. Preview before starting. Missing/unverifiable objects and path collisions need operator resolution.
4. Start recovery and monitor its durable job under Backup. After successful byte verification, Maple registers/reindexes the recovered directory. Originals and XMP sidecars retain their exact backed-up bytes; derived caches can be rebuilt.

Recovery refuses existing files, symlinks, path traversal, case/Unicode collisions and reserved internal paths. It writes exclusive temporary files, verifies size and SHA-256, flushes them, then publishes without overwriting another file. It checks purge records again during download, publication and indexing. When different entries resolve to the same path, recover them separately. Conflicting content-deduplicated metadata on an existing live asset is rejected; use a separate server when preserving both incompatible lifecycle states is required.

Use an owner-controlled recovery directory. Other processes must not replace its parent directories during recovery: the filesystem checks do not atomically pin parent names through file publication.

The job pins its selected immutable manifests and keeps a `.maple-recovery-<jobId>.json` journal in the target. Preserve that journal and directory to resume the same job after interruption. Use the recovery job's **Resume** action for a failed or cancelled job; a process interruption can be reclaimed by the runner after its lease expires. Resume validates the destination/root/account, selection, directory device/inode, and already published bytes. It does not silently switch to a newer remote version or accept a replacement directory. Cancellation leaves already verified files and the journal; it removes incomplete temporary downloads. A different recovery job should use another empty directory.

Recovery reconstructs photo/library metadata, not the old server's full configuration or users. It creates a recovered library without reassigning an existing destination or transplanting the old database's backup identities. Backing that recovered library up creates new entries; deleting a new copy does not authorize deletion of the original archive's entries. Keep a consistent SQLite/server backup to resume the original server identities and deletion obligations. The remote catalog can reconstruct backed-up bytes after local catalog loss, subject to the unpublished-purge limitation above.

## Adding another cloud provider

The provider boundary is `src/api/src/cloud-backup/provider.ts`. Google-specific IDs, authorization and resumable state stay under `google/`. Existing folder mirrors retain their established filesystem path. To implement a concrete second cloud provider:

- Add its actual destination kind, owner-only configuration UI/routes and least-privilege authorization. Keep exchange/renewal credentials on the Self Hosted server and validate account/root identity.
- Implement probe, complete paged prefix listing, verified inspection, replayable streaming publish/download, exact-object removal and upload abort. Opaque durable checkpoints carry a provider name and version; each adapter rejects checkpoints for another provider or unsupported version.
- Preserve logical keys, immutable manifests and purge records independently of provider locators. Bind each locator to its expected key, size, SHA-256 and current permitted root. Read back bytes when the provider lacks a trustworthy compatible checksum.
- Make retries idempotent across lost upload responses and process crashes. Persist reservations/checkpoints before external side effects, honor abort signals, and fence stale destination generations and entry leases.
- Test partial uploads, changed credentials/root, account mismatch, moved objects, offline purge obligations, late upload completion after purge, corrupt metadata, fresh-database catalog recovery and interrupted exclusive restores. A returned success must mean verified completion, not eventual delivery.

No future-provider adapters or placeholder credentials are shipped. The common engine is exercised with an in-process provider in lifecycle/recovery tests; Google protocol tests use controlled HTTP responses. These tests cover failure mechanics without claiming a real Google account, production deployment or provider conformance for an unimplemented service.
