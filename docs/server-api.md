# HTTP Route Reference

Every HTTP endpoint the Maple server exposes, grouped by area. Routes are defined in `src/api/src/routes/` (plus `src/api/src/workers/routes-main.ts` and `workers/generated-search/routes.ts`) as Elysia plugins, each carrying a prefix; `src/api/src/index.ts` mounts them, and `src/api/src/routes/authed-api.ts` is the wrapped sub-app that applies one shared `requireAuth` to the bulk of them. Handler mechanics, the auth model, and the settings system are in [api](api.md).

The server also serves an OpenAPI description of itself: Scalar UI at `/docs`, spec JSON at `/openapi.json`, both unauthenticated so clients can codegen DTOs from them.

## Auth legend

| Marker      | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| public      | No credential required                                                                        |
| bearer      | Valid access token in `Authorization: Bearer`                                                 |
| +file       | Bearer plus the per-user `file_access` permission                                             |
| owner       | Bearer plus `role: owner`                                                                     |
| +step-up    | Additionally requires a fresh `X-Step-Up` token from `POST /api/auth/step-up/verify`          |
| ?token      | Access token in the `token` query parameter (media elements and WebSockets can't set headers) |
| capability  | Bearer, or a path-bound image-capability token in `?token=`                                   |
| service key | A `maple_sk_…` service API key, not a user token                                              |

Anything marked bearer or stricter returns the standard error envelope on failure: `{ error, code, requestId, details? }`.

## Health and network

| Method | Path                         | Auth   | Purpose                                                                                                                                               |
| ------ | ---------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                | public | Liveness, plus optional MongoDB status. Backs the Docker health check                                                                                 |
| GET    | `/api/network/local-address` | public | This server's LAN address and port, so clients on the same network can prefer it over the public URL. Same trust tier as `/api/health` — no user data |
| GET    | `/api/network/config`        | bearer | Effective network config plus per-field source                                                                                                        |
| PUT    | `/api/network/config`        | bearer | Validate and save the operator's LAN-address override                                                                                                 |

## Authentication

Passkey ceremonies are two-step throughout: an `options` call returns the WebAuthn challenge, a `verify` call consumes it.

| Method | Path                            | Auth            | Purpose                                                                                                          |
| ------ | ------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/auth/bootstrap`           | public          | Whether this server has been claimed yet, so a fresh client knows to show register-as-owner or redeem-invite     |
| POST   | `/api/auth/register/options`    | public          | Registration challenge. Body carries email and, for a non-owner, an invite code                                  |
| POST   | `/api/auth/register/verify`     | public          | Complete registration. First registration claims ownership; later ones consume an invite                         |
| POST   | `/api/auth/login/options`       | public          | Authentication challenge                                                                                         |
| POST   | `/api/auth/login/verify`        | public          | Complete sign-in; mints a 15-minute access token and a 90-day refresh token                                      |
| POST   | `/api/auth/refresh`             | public          | Rotate a refresh token for a new pair. Replay inside the 60-second grace window is treated as a retry, not theft |
| POST   | `/api/auth/logout`              | public          | Revoke the refresh family and clear the cookie. Body: optional `refresh_token`                                   |
| POST   | `/api/auth/dev-login`           | public          | Passkey bypass. Only registered when `MAPLE_DEV_AUTH=1`; never in production                                     |
| GET    | `/api/auth/me`                  | bearer          | The signed-in user: id, email, role, `file_access`                                                               |
| POST   | `/api/auth/step-up/options`     | bearer          | Challenge for a step-up re-authentication                                                                        |
| POST   | `/api/auth/step-up/verify`      | bearer          | Mint the short-lived `X-Step-Up` token that gates sensitive actions                                              |
| POST   | `/api/auth/credentials/options` | bearer          | Challenge for adding a passkey                                                                                   |
| POST   | `/api/auth/credentials/verify`  | bearer +step-up | Register the new passkey                                                                                         |
| DELETE | `/api/auth/credentials/:id`     | bearer +step-up | Remove a passkey                                                                                                 |
| POST   | `/api/auth/invites`             | owner +step-up  | Mint an 8-character, single-use, 15-minute invite. Body: `{ email }`                                             |
| GET    | `/api/auth/invites`             | owner           | List invites with their expiry and consumption state                                                             |
| DELETE | `/api/auth/invites/:code`       | owner +step-up  | Rescind an invite                                                                                                |
| POST   | `/api/auth/device-sessions`     | bearer          | Mint a paired-device session (Maple TV) on proof of a refresh token                                              |
| GET    | `/api/auth/device-sessions`     | bearer          | List paired devices                                                                                              |
| DELETE | `/api/auth/device-sessions/:id` | bearer +step-up | Revoke a paired device                                                                                           |
| POST   | `/api/auth/native-code`         | bearer          | Issue a one-time PKCE code for a native shell, bound to its S256 challenge and opaque state                      |
| POST   | `/api/auth/native-code/redeem`  | public          | Native app exchanges code + verifier for device-scoped tokens                                                    |
| POST   | `/api/auth/native-code/claim`   | public          | Polling variant for the Windows shell, which can't receive a `maple-app://` redirect                             |
| POST   | `/api/auth/lan-handoff`         | bearer          | Issue a one-time code so a signed-in public-URL session can continue on the LAN origin                           |
| POST   | `/api/auth/lan-handoff/redeem`  | public          | Exchange that code for a session on the LAN origin                                                               |

### Users and service keys

| Method | Path                                 | Auth           | Purpose                                                                                                                                                                  |
| ------ | ------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/users`                         | owner          | Account roster: id, email, role, permissions                                                                                                                             |
| PATCH  | `/api/users/:id`                     | owner          | Set `file_access` and/or `role`. Refuses to demote the last owner. Changes land only in newly minted tokens — an in-flight one keeps its old claims for up to 15 minutes |
| GET    | `/api/admin/service-api-keys`        | owner          | List service keys (metadata only; the secret is shown once at creation)                                                                                                  |
| POST   | `/api/admin/service-api-keys`        | owner +step-up | Mint a key. Body: `{ name, scopes?, expiresAt? }`; the only scope today is `assets:search`                                                                               |
| DELETE | `/api/admin/service-api-keys/:keyId` | owner +step-up | Revoke a key                                                                                                                                                             |

## Libraries and folders

A library is a registered root folder with a slug. `:id` is the folder's Mongo id.

| Method | Path                              | Auth   | Purpose                                                                                                                                   |
| ------ | --------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/folders`                    | bearer | Registered libraries with their roots, slugs, and connectivity                                                                            |
| POST   | `/api/folders`                    | bearer | Register a new library root and trigger the first scan                                                                                    |
| GET    | `/api/folders/:id/assets`         | bearer | Paged asset list for a library                                                                                                            |
| POST   | `/api/folders/:id/rescan`         | +file  | Reset every stage version on the library's assets so the pipeline reprocesses them                                                        |
| POST   | `/api/folders/:id/scan`           | +file  | Run a discover scan synchronously and return once it's done, so a caller can refresh its listing                                          |
| POST   | `/api/folders/:id/upload`         | +file  | Stream a file into the library at a relative path. The one route allowed a multi-GB body — the handler writes straight to disk after auth |
| GET    | `/api/folders/:id/file`           | +file  | Stream raw bytes of a file by library-relative path. Reaches files that have no catalog row, which `/api/assets/:id/raw` cannot           |
| GET    | `/api/folders/:id/file-meta`      | +file  | Stat that file (size, mtime) without downloading it                                                                                       |
| POST   | `/api/folders/:id/mkdir`          | +file  | Create a directory                                                                                                                        |
| POST   | `/api/folders/:id/move`           | +file  | Move a directory within the library                                                                                                       |
| GET    | `/api/folders/:id/trash`          | bearer | Soft-deleted assets in this library that still have a recorded original path                                                              |
| DELETE | `/api/folders/:id/file`           | +file  | Delete a non-asset file by library-relative path                                                                                          |
| POST   | `/api/folders/:id/file/relocate`  | +file  | Move or copy a non-asset file                                                                                                             |
| POST   | `/api/folders/:id/trash-folder`   | +file  | Recursively trash a folder and everything under it                                                                                        |
| POST   | `/api/folders/:id/restore-folder` | +file  | Restore a recursively trashed folder                                                                                                      |
| POST   | `/api/library/relocate-count`     | bearer | Count how many of the given `addresses` would move into their canonical `<year>/<region>/<city>/` folder                                  |
| POST   | `/api/library/relocate`           | bearer | Perform that relocation, sidecars included. Per-asset error isolation; crash-safe copy → verify → repoint → delete                        |
| GET    | `/api/folders/:id/mirror`         | bearer | This library's configured mirror (backup) locations                                                                                       |
| PUT    | `/api/folders/:id/mirror`         | bearer | Replace the mirror set; validates roots and reloads the in-memory registry                                                                |
| POST   | `/api/mirror/test`                | bearer | Validate a candidate mirror path without saving                                                                                           |
| GET    | `/api/mirror/status`              | bearer | Mirror queue depth (pending, dead) plus live reconcile progress                                                                           |
| POST   | `/api/mirror/reconcile`           | bearer | Run a full scan-then-copy reconcile now                                                                                                   |
| POST   | `/api/mirror/retry-dead`          | bearer | Re-arm dead-lettered mirror copies                                                                                                        |
| GET    | `/api/mirror/orphans`             | bearer | Dry-run report of mirror files with no primary counterpart. Deletes nothing                                                               |

## Unified addressing (`slug:relPath`)

The four routes clients should prefer. Each resolves the slug through an in-memory cache and jails the relative path with a realpath check.

| Method | Path                   | Auth       | Purpose                                                                                                                                                                                                                            |
| ------ | ---------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/folder/:slug`    | +file      | Library-root listing. Registered separately because Elysia's `*` doesn't match an empty tail                                                                                                                                       |
| GET    | `/api/folder/:slug/*`  | +file      | Sub-folder listing: indexed assets from Mongo merged with on-disk files not yet catalogued (`indexed: false`), enqueuing a discover scan for the strays                                                                            |
| GET    | `/api/image/:slug/*`   | bearer     | Stream the original file bytes; Content-Type from the extension                                                                                                                                                                    |
| GET    | `/api/thumb/:slug/*`   | capability | Thumbnail AVIF. `ETag: "<maple_id>"`, immutable caching, 304 on `If-None-Match`. Generates on a cache miss; `202` with `Retry-After: 2` when the file exists but isn't indexed yet. This is the route the Cloudflare Worker fronts |
| GET    | `/api/preview/:slug/*` | capability | 1280 px preview AVIF, generated on a cold miss. ETag is the preview file's own mtime and size with `must-revalidate`, so an editor overwriting it busts client caches                                                              |
| GET    | `/api/video/:slug/*`   | ?token     | Ranged video streaming                                                                                                                                                                                                             |
| GET    | `/api/video/fs`        | ?token     | Ranged video streaming by absolute path                                                                                                                                                                                            |

## Path-addressed filesystem

The older absolute-path surface, still used by the Apple File Provider and cloud-source browse. All share the `MAPLE_ROOTS` jail and the system-directory denylist.

| Method | Path               | Auth   | Purpose                                                                                                                                                                  |
| ------ | ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/fs/roots`    | +file  | The configured browse roots                                                                                                                                              |
| GET    | `/api/fs/list`     | +file  | Subdirectories under `?path=` (no files). Backs the library-picker empty state. `showAll=0\|1`                                                                           |
| GET    | `/api/fs/dir`      | +file  | Directories and image files at one level, enriched with catalog `asset_id`, EXIF, and paired sidecars. Two Mongo `$in` lookups per request. Paged via `cursor` + `limit` |
| GET    | `/api/fs/dir-fast` | +file  | Same paging contract, pure filesystem — no Mongo, no EXIF, no sidecars. Backs the Angular browse grid                                                                    |
| GET    | `/api/fs/raw`      | +file  | Stream the original bytes at `?path=`. Allowlisted to RAW ∪ bitmap extensions; others get 415. May be served from a mirror when the primary volume is unreachable        |
| GET    | `/api/fs/thumb`    | bearer | Thumbnail AVIF for `?path=`, cached at `.maple/thumbs/`. A cache hit is one `readFile`. Deliberately no `size` parameter                                                 |
| GET    | `/api/fs/preview`  | bearer | 1280 px preview for `?path=`, cached at `.maple/previews/`. Falls back to on-demand generation for un-indexed files                                                      |

## Assets

`:id` is the asset's Mongo id.

| Method | Path                                 | Auth   | Purpose                                                                                                                                                                                                                    |
| ------ | ------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/assets`                        | +file  | Minimal list for the File Provider working set. Filters `has_xmp=1`, `rating_gte=N`, `captured_after=<ISO>`, `limit` (default 1000, max 20000)                                                                             |
| GET    | `/api/assets/:id`                    | bearer | Full asset metadata                                                                                                                                                                                                        |
| GET    | `/api/assets/by-address`             | bearer | Same, addressed by `slug:relPath`                                                                                                                                                                                          |
| GET    | `/api/assets/by-fspath`              | bearer | Same, addressed by absolute filesystem path                                                                                                                                                                                |
| POST   | `/api/assets/batch-meta`             | bearer | Metadata for many ids in one round trip                                                                                                                                                                                    |
| GET    | `/api/assets/:id/raw`                | bearer | Stream the original RAW bytes                                                                                                                                                                                              |
| GET    | `/api/assets/:id/thumb`              | bearer | Thumbnail from the `.maple/` cache                                                                                                                                                                                         |
| GET    | `/api/assets/:id/histogram`          | bearer | 3×256-bin RGB histogram JSON for the asset's current XMP, so each client draws the curves itself. Cached at `.maple/previews/<filename>.histogram.json` keyed on RAW mtime plus sidecar mtime, so a re-edit invalidates it |
| GET    | `/api/assets/:id/xmp`                | bearer | Read the sidecar                                                                                                                                                                                                           |
| PUT    | `/api/assets/:id/xmp`                | bearer | Write the sidecar                                                                                                                                                                                                          |
| DELETE | `/api/assets/:id/xmp`                | bearer | Delete the sidecar                                                                                                                                                                                                         |
| DELETE | `/api/assets/:id`                    | +file  | Dual mode: soft-delete into `.maple/trash/` when live, permanently purge when already trashed. 204 either way                                                                                                              |
| POST   | `/api/assets/:id/restore`            | +file  | Move back out of trash; returns filename, size, and mtime so the File Provider can rebuild metadata without a stat                                                                                                         |
| POST   | `/api/assets/:id/relocate`           | +file  | Move or copy one asset with its sidecars                                                                                                                                                                                   |
| POST   | `/api/assets/:id/rename`             | +file  | Rename one asset with its sidecars                                                                                                                                                                                         |
| POST   | `/api/assets/batch-rename/preview`   | +file  | Dry-run a filename-template batch rename                                                                                                                                                                                   |
| POST   | `/api/assets/batch-rename`           | +file  | Apply it, sequentially                                                                                                                                                                                                     |
| PUT    | `/api/assets/:id/place`              | bearer | Manual place override                                                                                                                                                                                                      |
| PUT    | `/api/assets/:id/description`        | bearer | Manual caption override                                                                                                                                                                                                    |
| POST   | `/api/assets/:id/enrichment/requeue` | bearer | Reset one stage's version so the pipeline reprocesses this asset                                                                                                                                                           |
| GET    | `/api/photos/hidden`                 | bearer | Assets flagged hidden, newest first, capped at 200. `onlyNew=true` narrows to unacknowledged nudity flags                                                                                                                  |
| POST   | `/api/assets/:id/hidden-ack`         | bearer | Acknowledge a hidden-flag alert                                                                                                                                                                                            |

## Sidecars, previews, and metadata

| Method | Path                      | Auth   | Purpose                                                                                                                                                                                                   |
| ------ | ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/xmp`                | bearer | Read the sidecar for `?path=`. Path-keyed, not id-keyed, so two paths sharing a `maple_id` keep two distinct sidecars                                                                                     |
| POST   | `/api/xmp`                | bearer | Write it. Body is the full XMP document                                                                                                                                                                   |
| DELETE | `/api/xmp`                | bearer | Delete it                                                                                                                                                                                                 |
| POST   | `/api/xmp/batch`          | bearer | Merge metadata fields into N sidecars addressed by `slug:relPath`, then mark each asset's `sidecar-metadata-index` stage dirty. Per-entry failure reporting; successes are not rolled back                |
| POST   | `/api/metadata/snapshots` | bearer | Effective metadata for a batch of paths, merging `metadata_override` over `exif`. Only non-null fields appear, so the Batch Metadata panel can detect mixed state                                         |
| PUT    | `/api/preview`            | bearer | Publish an already-rendered preview for `?path=` into `.maple/previews/`. Accepts AVIF or JPEG (sniffed by Content-Type then magic bytes) and transcodes JPEG to AVIF; the write is temp-file-then-rename |

## Search

Every filter parameter below is shared by `/api/search`, `/api/search/facets`, `/api/search/buckets`, and `/api/map/clusters`, declared once in `routes/search/query-schema.ts`.

| Method | Path                                 | Auth        | Purpose                                                                                                                                                                                                                                     |
| ------ | ------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/search`                        | bearer      | Paginated results. Default capture-time sorts use seek pagination and answer with `cursorPaging: true` plus a `nextCursor`; every other sort, and the text/Meili path, stays on `page`/`limit` and says `cursorPaging: false`               |
| GET    | `/api/search/facets`                 | bearer      | Six parallel aggregations (count, cameras, lenses, extensions, ISO range, capture range) over the caller's current filter, so dropdowns show what's in scope rather than the global universe                                                |
| GET    | `/api/search/buckets`                | bearer      | Year/month histogram for the Timeline, off pre-computed `exif.captured_year`/`month` so the group is index-only. Cached 30s per filter set                                                                                                  |
| GET    | `/api/map/clusters`                  | bearer      | Zoom-dependent lat/lng grid aggregation feeding the map's heat and pins. Adds `bbox` (`west,south,east,north`) and `zoom` to the search filters; payload is bounded by visible cells, not library size                                      |
| POST   | `/api/search/assets`                 | service key | Machine-facing search for external integrations. Body: `{ query, mode?: 'hybrid'\|'lexical', limit?, includeHidden?, from?, to?, filters? }`. Rate-limited per key; falls back to lexical with a reason when semantic search is unavailable |
| GET    | `/api/generated-searches`            | bearer      | The day's themed collections invented by the generated-search worker                                                                                                                                                                        |
| GET    | `/api/generated-searches/:id/assets` | bearer      | Re-run one collection's stored query and return results. Re-running (rather than materialising) is what forces hidden-people and screenshot exclusions onto queries written by older worker versions                                        |

Common search filters: `q` (filename substring), `placeQuery` (full-text over place, description, and OCR), `libraryId`, `camera`, `lens`, `isoMin`/`isoMax`, `apertureMin`/`apertureMax`, `focalMin`/`focalMax`, `from`/`to`, `month` (recurring month-of-year), `rating`, `flag`, `color`, `ext`, `pathPrefix`, `hasCapturedAt`, `sceneType`, `activity`, `subjects` (comma-separated), `people` (comma-separated names), `place` (pipe-separated labels), `isScreenshot`, `scope` (`photos` | `places` | `people` | `albums`), plus `sort`, `page`, `limit`, `cursor`.

## People

| Method | Path                                       | Auth   | Purpose                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/people`                              | bearer | People with face counts, excluding hidden                                                                                                                                                                                                |
| GET    | `/api/people/hidden`                       | bearer | Soft-hidden people                                                                                                                                                                                                                       |
| GET    | `/api/people/excluded`                     | bearer | People excluded from clustering                                                                                                                                                                                                          |
| GET    | `/api/people/:id`                          | bearer | One person plus recent face thumbnails                                                                                                                                                                                                   |
| POST   | `/api/people`                              | bearer | Create or return an existing person. Body: `{ name }`                                                                                                                                                                                    |
| PUT    | `/api/people/:id`                          | bearer | Rename; merges on a name collision                                                                                                                                                                                                       |
| POST   | `/api/people/merge`                        | bearer | Merge source people into a target, which survives                                                                                                                                                                                        |
| POST   | `/api/people/:id/dismiss-merge-suggestion` | bearer | Mark a suggested merge as "not a match"                                                                                                                                                                                                  |
| POST   | `/api/people/:id/cover`                    | bearer | Set the cover face                                                                                                                                                                                                                       |
| POST   | `/api/people/:id/hide` / `/unhide`         | bearer | Soft-hide or restore a person, keeping faces and the row                                                                                                                                                                                 |
| POST   | `/api/people/:id/exclude` / `/unexclude`   | bearer | Exclude a person from clustering, or re-include                                                                                                                                                                                          |
| POST   | `/api/people/cluster`                      | bearer | Kick off online clustering                                                                                                                                                                                                               |
| POST   | `/api/people/assign`                       | bearer | Manual face-to-person override                                                                                                                                                                                                           |
| POST   | `/api/people/hide`                         | bearer | Hide a single face so clustering ignores it                                                                                                                                                                                              |
| POST   | `/api/admin/faces/purge-subthreshold`      | bearer | Audit (default) or, with `?apply=true`, remove faces below the configured minimum detection size. Preserves hidden faces always, and assigned faces unless `includeAssigned=true`. Removal is an atomic `$pull`, not a read-modify-write |

## Geocoding

| Method | Path                   | Auth   | Purpose                                                                                                                                                                                                              |
| ------ | ---------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/geocode/reverse` | public | Cached `Place` for `?lat=&lon=` (`precision` defaults to 4 decimal places), 404 when the cache misses. Public because it returns no user data — backup clients call it to pick a destination folder before uploading |
| GET    | `/api/geocode/search`  | bearer | Forward-geocode typeahead proxying to the configured Nominatim, up to 5 candidates. Uncached; 503 when no Nominatim URL is set                                                                                       |

## Backup ingest (PhotoKit devices)

All six require a bearer — they write files and reconcile deletions. Resume identity comes from the `X-Maple-Device-Id` and `X-Maple-Phasset-Id` headers.

| Method | Path                                              | Auth   | Purpose                                                                                                                                                                                                    |
| ------ | ------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/libraries/:libraryId/backup/exists`         | bearer | Dedup probe. Body `{ maple_ids: string[] }` (max 1000); returns the subset the server doesn't have                                                                                                         |
| GET    | `/api/libraries/:libraryId/backup/state`          | bearer | Reconciliation feed: assets already seen from `device_id`, optionally `since` an ISO timestamp                                                                                                             |
| POST   | `/api/libraries/:libraryId/backup/ingest`         | bearer | Chunked resumable upload. `202` = send more, `200` = complete (returns `maple_id` and `target_rel_path`), `409` = resume from `expected_offset`, `423` = another device is uploading the same iCloud photo |
| POST   | `/api/libraries/:libraryId/backup/rendered`       | bearer | Same protocol for the Photos-edited companion, landing at `<base>.rendered.<ext>`                                                                                                                          |
| POST   | `/api/libraries/:libraryId/backup/sidecar`        | bearer | Write an XMP sidecar next to a previously uploaded asset, addressed by `X-Maple-Target-Rel-Path`                                                                                                           |
| POST   | `/api/libraries/:libraryId/backup/notify-deleted` | bearer | Body `{ phasset_local_ids }`; marks the cloud copies `deleted_from_photos`. The rows and bytes stay                                                                                                        |

## Imports and jobs

| Method | Path                      | Auth   | Purpose                                                                                                                                                                           |
| ------ | ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/imports/scan`       | +file  | Walk a server-local source folder and return buckets. Source must pass the roots jail                                                                                             |
| POST   | `/api/imports`            | +file  | Create a pending import; returns `{ id }`. Every bucket label is re-validated server-side as a safe directory segment                                                             |
| GET    | `/api/imports`            | +file  | List imports, newest first. `status`, `limit`                                                                                                                                     |
| GET    | `/api/imports/:id`        | +file  | Full import document with per-file progress                                                                                                                                       |
| POST   | `/api/imports/:id/cancel` | +file  | Request cancel, honoured between files                                                                                                                                            |
| POST   | `/api/imports/:id/retry`  | +file  | Reset failed files to pending and clear the lease so a worker re-claims it. Copied files stay copied and dedup-skip on the re-run                                                 |
| POST   | `/api/jobs`               | bearer | Queue a JobRunner job. The only kind this route accepts is `batch_jpeg_export`; pano jobs are created through `/api/pano/stitch`                                                  |
| GET    | `/api/jobs`               | bearer | List jobs, newest first. `status`, `kind`, `limit`                                                                                                                                |
| GET    | `/api/jobs/:id`           | bearer | Job document with progress                                                                                                                                                        |
| POST   | `/api/jobs/:id/cancel`    | bearer | Set `cancel_requested`                                                                                                                                                            |
| POST   | `/api/pano/stitch`        | bearer | Create a `pano_stitch` job. `409 pano_not_provisioned` when no binary is configured, `409 pano_job_running` when one is already running (they're heavy — minutes, tens of GB RSS) |
| GET    | `/api/pano/jobs/:id`      | bearer | Pano job status and progress                                                                                                                                                      |
| DELETE | `/api/pano/jobs/:id`      | bearer | Cancel an in-flight stitch                                                                                                                                                        |

## Change feed

| Method | Path                     | Auth   | Purpose                                                                                                                                                                              |
| ------ | ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/changes`           | +file  | Poll form: up to `limit` rows (default 100, max 1000) with cursor greater than `since`                                                                                               |
| GET    | `/api/changes/subscribe` | +file  | SSE form: replays buffered events past `since`, then streams. 10,000-event backlog cap, 15s keepalive comments, 5-minute forced recycle so an expired token can't outlive its stream |
| WS     | `/api/events`            | ?token | WebSocket carrying worker status frames (`status`, `progress`, `process`). Authenticates via query parameter because browsers can't set headers on `new WebSocket()`                 |

## Workers

Pause and config changes are written to `worker_config` in Mongo; the worker child re-reads it on its next poll tick, so there is no IPC.

| Method | Path                                       | Auth   | Purpose                                                                 |
| ------ | ------------------------------------------ | ------ | ----------------------------------------------------------------------- |
| GET    | `/api/workers/status`                      | bearer | Per-stage rows: pending, ready, dead, in-flight, throughput. Cached     |
| GET    | `/api/workers/performance`                 | bearer | FFI decode-pool size and the on-demand preview limiter                  |
| PATCH  | `/api/workers/performance`                 | bearer | Resize the pool live, clamped to its min/max                            |
| POST   | `/api/workers/:name/pause`                 | bearer | Pause one stage                                                         |
| POST   | `/api/workers/:name/resume`                | bearer | Resume it                                                               |
| PATCH  | `/api/workers/:name/config`                | bearer | Patch its concurrency, batch size, and target version                   |
| GET    | `/api/workers/:name/dead`                  | bearer | Dead-lettered assets for that stage                                     |
| POST   | `/api/workers/:name/retry-dead`            | bearer | Re-arm them                                                             |
| GET    | `/api/workers/damaged`                     | bearer | Assets tagged damaged by a stage                                        |
| POST   | `/api/workers/damaged/clear`               | bearer | Clear the damaged tags                                                  |
| GET    | `/api/workers/missing-reaper/prune-window` | bearer | How long a missing file waits before the reaper acts                    |
| PATCH  | `/api/workers/missing-reaper/prune-window` | bearer | Change that window                                                      |
| GET    | `/api/workers/deduplicate/config`          | bearer | Dedupe worker settings                                                  |
| PATCH  | `/api/workers/deduplicate/config`          | bearer | Change them                                                             |
| GET    | `/api/workers/migration/migrations`        | bearer | Every registered data migration and its enable/progress state           |
| PATCH  | `/api/workers/migration/migrations/:id`    | bearer | Enable, disable, or reset one                                           |
| GET    | `/api/workers/generated-search/config`     | bearer | Generated-search worker settings                                        |
| PATCH  | `/api/workers/generated-search/config`     | bearer | Change them                                                             |
| POST   | `/api/workers/generated-search/run`        | bearer | Generate today's collections now                                        |
| GET    | `/api/derivative-audit/status`             | bearer | Config plus last-pass progress for the derivative reconciliation worker |
| PUT    | `/api/derivative-audit/config`             | bearer | Patch that config                                                       |
| POST   | `/api/derivative-audit/run`                | bearer | Kick a pass; returns immediately                                        |

Stage names accepted by the `:name` routes come from `workers/stages/manifest.ts` — `exif`, `thumb`, `preview`, `face-detect`, `face-embed`, `describe`, `geocode`, `meili`, `sidecar-metadata-index`, `cf-thumb-sync`, `transcribe` — plus the non-stage controllers `missing-reaper`, `migration`, `deduplicate`, and `discover`.

## Settings

Every one of these reads and writes a document in `app_settings`, so a change takes effect without a restart.

| Method | Path                                         | Auth   | Purpose                                                                                                         |
| ------ | -------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/enrichment/config`                     | bearer | Effective enrichment config plus per-field source. Secrets are never echoed                                     |
| PUT    | `/api/enrichment/config`                     | owner  | Save it. Owner-only because it can repoint `meilisearch_url` at another host, taking the stored API key with it |
| POST   | `/api/enrichment/test`                       | bearer | Health-check an arbitrary Nominatim URL without saving                                                          |
| POST   | `/api/enrichment/test-meili`                 | bearer | Same for a Meilisearch URL                                                                                      |
| POST   | `/api/enrichment/test-describe`              | bearer | Same for a describe provider                                                                                    |
| GET    | `/api/cloudflare/config`                     | owner  | R2 config, secret redacted                                                                                      |
| PUT    | `/api/cloudflare/config`                     | owner  | Save it; validates credentials before persisting when enabling                                                  |
| POST   | `/api/cloudflare/test`                       | owner  | Round-trip a probe object through R2 without saving                                                             |
| GET    | `/api/observability/config`                  | bearer | Resolved OTel config — including `ingestion_key`, because client transports post to SigNoz directly with it     |
| PUT    | `/api/observability/config`                  | bearer | Save it and hot-reconfigure the running SDK                                                                     |
| POST   | `/api/observability/test`                    | bearer | POST an empty span batch to verify reach and auth without saving                                                |
| POST   | `/api/observability/otlp/v1/:signal`         | bearer | Proxy client telemetry (`traces`, `logs`) upstream                                                              |
| GET    | `/api/render/config`                         | bearer | Web GPU live-render ramp/kill switch. Read by every signed-in client at startup and on a poll                   |
| PUT    | `/api/render/config`                         | bearer | Flip it                                                                                                         |
| GET    | `/api/display/config`                        | bearer | Display preferences, e.g. `show_hidden_images`                                                                  |
| PUT    | `/api/display/config`                        | bearer | Save them                                                                                                       |
| GET    | `/api/map/config`                            | bearer | Base-map tile URL plus source (`db` or `default`). This route never sees photo coordinates                      |
| PUT    | `/api/map/config`                            | bearer | Save the operator override                                                                                      |
| GET    | `/api/pano/config`                           | bearer | Pano config plus `strategySupported`, probed once per process from `maple-cli pano stitch --help`               |
| PUT    | `/api/pano/config`                           | bearer | Save it                                                                                                         |
| GET    | `/api/presets`                               | bearer | User develop presets, name-sorted. Built-in presets ship inside each client and are not served here             |
| POST   | `/api/presets`                               | bearer | Create one from a sparse, schema-versioned adjustment model. `409` on a duplicate name                          |
| DELETE | `/api/presets/:id`                           | bearer | Delete one                                                                                                      |
| GET    | `/api/admin/enrichment/meilisearch-status`   | owner  | Index health, document counts, and semantic-vector coverage                                                     |
| POST   | `/api/admin/enrichment/backfill-meilisearch` | owner  | Bulk reindex, leased so it survives a restart                                                                   |

## Static UI

| Method | Path | Auth   | Purpose                                                                                                                                                                                                                             |
| ------ | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/*` | public | Catch-all mounted last. Serves the Angular bundle and falls through to `index.html` for client-side routes; proxies to the dev server when `MAPLE_DEV=1`. Deliberately ungated so an unauthenticated cold load can reach `/sign-in` |

## Not mounted

`routes/enrichment-admin.ts` defines `GET`, `GET /groups`, and `POST /reset` under `/api/enrichment/dead-letter`, but nothing imports the plugin, so those paths are not reachable on a running server. Per-stage dead-letter inspection is served by `/api/workers/:name/dead` instead.
