# Implementation plan — #744 backup layout + Migration worker

Spec: `docs/superpowers/specs/2026-05-31-backup-layout-and-migration-worker.md`.

## Phase 1 — Path format (TS + Swift)

- `src/api/src/backup/path-formatter.ts`: drop day folder in both branches.
- `src/apple/.../MapleBackup/Sources/MapleBackup/PathFormatter.swift`: same.
- Update header docstrings (layout block) in both.
- `path-formatter.test.ts` + `PathFormatterTests.swift`: new expected strings.
- `BackupSettingsView.swift`: `BackupPathPreview` sample + fallback literal.
- Gate: `bun test path-formatter` + `swift test` (MapleBackup pkg, no xcframework).

## Phase 2a — Worker scaffolding (API)

- `workers/migration/registry.ts` — `Migration` interface + `MIGRATIONS` array.
- `workers/migration-config.repo.ts` — load/save per-migration state in
  `app_settings` doc `_id:"migration"`. `app_settings`-pattern from
  `missing-reaper-config.repo.ts`.
- `workers/migration.ts` — `startMigration()`: interval loop + `stageRegistry`
  registration (copy missing-reaper's register/pause/persist scaffolding).
- `workers/maintenance.ts` — start/stop migration alongside reaper.
- `workers/routes-main.ts` — `GET .../migration/migrations`,
  `PATCH .../migration/migrations/:id`.
- `workers/routes-status.ts` — special-case migration `pending` =
  Σ countRemaining of enabled migrations (mirror missing-reaper block + add to
  `CLAIM_STAGE_NAMES` exclusion already handled by gating).
- Gate: `bun test workers` (registration + routes).

## Phase 2b — Restructure migration

- `workers/migration/restructure-backup-folders.ts` — `countRemaining()` +
  `runBatch()` implementing the crash-safe move, collision, companion, cache,
  empty-folder logic. Pure-ish move helper extracted for unit testing.
- New small fs helper for full-file hash + copy→verify (or reuse noble sha256).
- Gate: `bun test` move-logic suite (copy/verify/collision/companion/ordering).

## Phase 2c — Frontend toggle UI

- `maple-common/.../workers-api.service.ts` — `listMigrations()` +
  `setMigrationEnabled()`.
- `settings/workers/*` — render a "Migrations" section with per-migration
  toggle + progress; wire PATCH.
- Gate: `bun run lint` + `bun run test` (web), build check.

## Phase 3 — Wrap-up

- Run full `bun test` (API) + `swift test` (MapleBackup).
- PR closing #744; add to Files board.

## Risk notes

- Never delete before the DB repoint (Phase 2b ordering).
- Dedupe only when companions are equal/absent on the survivor; else rename.
- `rmdir` guarded against library root.
- "no eyeballing": run both suites, paste output.
