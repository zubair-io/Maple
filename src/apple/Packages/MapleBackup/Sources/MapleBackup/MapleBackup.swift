//
// MapleBackup — device-side PhotoKit backup engine.
//
// This SPM module is the shared core for the macOS / iOS / iPadOS backup
// engine. It is hosted by `MapleApp` directly and (on macOS) also by the
// `MapleBackupAgent` LaunchAgent. The module exposes:
//
//   - BackupEngine actor — orchestrates the queue, upload client, sidecar
//     store, and state machine.
//   - BackupQueue protocol + InProcessBackupQueue — priority-ordered
//     in-memory queue. Per-task state persists in BackupStateStore so
//     restarts re-hydrate pending work, but the queue itself is rebuilt
//     in-process on each engine start.
//   - BackupStateStore — GRDB-backed runtime state persistence.
//   - PayloadAssembler — builds upload payloads from PhotoKit asset reads.
//   - UploadClient — chunked, resumable HTTPS upload.
//   - AppSupportSidecarStore — file-per-PHAsset .xmp shadow for
//     not-yet-uploaded edits.
//   - PathFormatter — mirror of the server formatter (parity-gated).
//   - GeocodeClient — wraps GET /api/geocode/reverse.
//   - DeviceIdentity — stable UUID per device-and-install.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md.

public enum MapleBackup {
    public static let version = "0.1.0"
}
