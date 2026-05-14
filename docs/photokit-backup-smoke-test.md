# PhotoKit Backup — Smoke Test Guide

Covers both the programmatic end-to-end server test and the GUI smoke-test procedure for validating the device-side PhotoKit flows.

---

## Programmatic smoke test (`src/scripts/test_backup_smoke.ts`)

### What it tests

The script walks through the complete server-side backup flow in a single self-contained run, with no fixtures needed beyond a running MongoDB instance and API server:

| Step | What is exercised |
|------|-------------------|
| 1 | Library folder seeded directly in MongoDB (`folders` collection) |
| 2 | `geocode_cache` seeded for Tokyo (lat 35.68 / lon 139.69) so the path-formatter produces a location-named directory |
| 3a | `POST /api/libraries/:id/backup/ingest` — chunk 1 of 2 (202 Accepted) |
| 3b | `POST /api/libraries/:id/backup/ingest` — final chunk (200 OK, assembles file) |
| 4 | Assembled original file on disk at the correct path (`2024/Tokyo/03-15/IMG_0001.HEIC`) |
| 5 | `POST /api/libraries/:id/backup/sidecar` — XMP sidecar upload |
| 6 | Sidecar file on disk (`…/IMG_0001.HEIC.xmp`) contains expected content |
| 7 | `POST /api/libraries/:id/backup/rendered` — rendered companion (single chunk, 200 OK) |
| 8 | Rendered companion on disk (`…/IMG_0001.rendered.jpg`) |
| 9 | `GET /api/libraries/:id/backup/state?device_id=X` — reconciliation feed contains the uploaded asset |
| 10 | `POST /api/libraries/:id/backup/notify-deleted` — delete notification (updated=1) |
| 11 | `assets.deleted_from_photos == true` in MongoDB |
| 12 | Cleanup: temp dir deleted, all test documents removed from MongoDB |

### Prerequisites

1. **MongoDB** — the test reads and writes directly to Mongo for setup/assertion steps:
   ```bash
   cd src/api && docker compose up -d mongo
   ```

2. **API server** — must be running on `http://localhost:3000` (or override via `$MAPLE_API_URL`):
   ```bash
   cd src/api && bun run dev
   ```

   The server can remain running between test runs — the script creates a unique PID-scoped test library and cleans it up on success.

3. **Bun** — the runtime for the test script. Install from https://bun.sh if not present.

### How to run

```bash
# Using the shebang (after chmod +x):
src/scripts/test_backup_smoke.ts

# Or explicitly via bun:
bun src/scripts/test_backup_smoke.ts

# Override API or Mongo URL:
MAPLE_API_URL=http://localhost:3001 bun src/scripts/test_backup_smoke.ts
MAPLE_MONGO_URI=mongodb://remotehost:27017 bun src/scripts/test_backup_smoke.ts
```

The script exits `0` on success and non-zero on the first failing step, printing which assertion failed and why.

### Note on `POST /api/folders`

The `/api/folders` registration endpoint is behind `requireAuth` (JWT passkey gate). The smoke test bypasses it by inserting the `folders` document directly via MongoDB. This means the test does not exercise the folder-registration endpoint — that remains part of the GUI flow.

Once a `DELETE /api/folders/:id` endpoint is added, the cleanup step can use it instead of the direct Mongo delete.

### How to extend

To test a new backup endpoint:

1. Add a numbered step after the existing ones (before Step 12 cleanup).
2. Use the existing `assertStatus()` helper for HTTP assertions.
3. Add any Mongo assertions directly via the `assetsColl` / `geocodeColl` handles.
4. Add any new test document deletions to Step 12 so the test stays self-cleaning.

To test the deduplication path, call the ingest endpoint twice with the same `X-Maple-Maple-Id` but a different `X-Maple-Device-Id`. The second call should return `200` with the original `target_rel_path` without writing a second file on disk.

---

## GUI smoke test (device-side PhotoKit flows)

The programmatic test covers the server endpoints. The device-side flows — PhotoKit change observation, queue management, and the in-app status panel — require Xcode and a real or simulated device.

### Prerequisites

- Xcode open on `src/apple/Maple.xcodeproj`
- API server running and reachable from the device/simulator (`http://localhost:3000` for simulator; your LAN IP for a real device)
- MongoDB running

### Procedure

1. **Build and run** — Build the scheme `Maple` targeting `My Mac` or an iOS simulator. Launch the app.

2. **Open Settings → Backup** — navigate to the backup configuration screen. Fill in:
   - Server URL: `http://localhost:3000`
   - Device name: any label

3. **Trigger a backup** — tap "Back up now" or wait for the automatic trigger. The status panel should transition through:
   - "Idle" → "Scanning library" → "Uploading N items"
   - Each asset card should show a progress indicator and then a green checkmark.

4. **Verify files on disk** — in Terminal, inspect the library folder the server is configured to use:
   ```bash
   find <libDir> -type f | sort
   ```
   You should see `<year>/<location-or-date>/<filename>`, `.xmp` sidecar, and `.rendered.jpg` (if Photos held edits) for each uploaded asset.

5. **Verify reconciliation** — force-quit and relaunch the app. The status panel should show "All items backed up" immediately (no re-upload) because the reconciliation feed from `GET /backup/state` covers the previously uploaded assets.

6. **Verify delete notification** — delete one photo from the Photos app. Within the next reconciliation cycle the Maple app should POST `notify-deleted`. Confirm in MongoDB:
   ```js
   db.assets.find({ deleted_from_photos: true })
   ```

### Expected status panel states

| State | What you should see |
|-------|---------------------|
| Connected | Server URL shown in green |
| Scanning | "Scanning N photos" with a spinner |
| Uploading | Progress bar with "N of M" counter |
| Idle / Done | "All N photos backed up" |
| Error | Red alert with the error description; tap for details |

### What the GUI test does NOT cover (handled by the programmatic test)

- Chunked upload resume (restart mid-upload and reconnect) — tested automatically by the two-chunk ingest in the programmatic test.
- Path-formatter location naming — verified by the geocode-cache seed + disk-path assertion in the programmatic test.
- Mongo `deleted_from_photos` state — verified directly in MongoDB by the programmatic test.
