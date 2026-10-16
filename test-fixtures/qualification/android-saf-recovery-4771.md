# Android sidecar recovery across library instances — #4771

## Defect and repair

`PhotoLibrary` used an instance-local persistence mutex, but every instance
accessed the same per-photo transaction journal and provider files. Two readers
could therefore recover one interrupted replacement concurrently. Reads can
rename/delete sidecars during recovery, so they must serialize with saves.

The existing mutex now belongs to the companion object and protects all
library instances in the app process. Recovery digest checks and conditional
saves retain their existing behavior. The system-folder integration test now
closes its activity before manually staging process-death fixtures; live
thumbnail readers can no longer consume a partially staged test transaction.

## Failing control

Two instrumented regressions use real XMP files behind the debug document
provider. The first library pauses immediately before opening the recovery
file; a second library then tries to load the same photo.

Both fail on the unchanged instance-local lock:

- Before publication, the competing reader restores the backup and removes
  the journal. The paused reader fails with `FileNotFoundException` in
  `SafSidecars.recover` when it opens the old backup URI.
- After publication, the competing reader completes cleanup. The paused
  reader fails with `Could not finish sidecar recovery` when deleting the
  already consumed journal.

The debug pause only coordinates provider calls; reads, writes, renames,
digests and conflict detection execute through the actual library and files.

## Passing qualification

Base: `4b519ca7898ebeccb4bcc15ca78183a16bf6bbbd`.
Device: API 36 arm64 emulator, SwiftShader, 1280×800 dp tablet layout.

- Focused device run: **3 passed, 0 failed, 0 skipped**, including the existing
  system-folder test and both new concurrency boundaries.
- Full device suite: **51 passed, 0 failed, 0 skipped**. A second complete run
  also passes after strengthening the conflict assertion to make a real
  external edit to the recovered sidecar before the stale writer saves.
- JVM suite: **30 passed, 0 failed, 0 skipped**.
- Android lint: **0 errors/fatal findings**, 48 warnings.
- Repository test-report accounting and file headroom checks pass.

The new tests require both concurrent readers to return the expected sidecar,
the journal and temporary siblings to disappear, original RAW bytes to remain
unchanged, and the external edit to survive a rejected stale save. The system
provider test retains both interruption boundaries, mixed-case sidecar names,
UTF-16 import, repeated saves and original-export alias protection.

The source patch and fixture hashes remain unchanged during both complete
runs. The final executable-source patch SHA-256 is
`5972f926b17ae31e2761bac979e59aa07f9a26937ed6f0329be1279d8cbc5c96`.
Logs, report XML, failing control, source patches and identity records are
archived under `/Volumes/Projects/maple-color-gate-20261015/android-saf-4771/`.
This qualifies the Android persistence repair; physical color results are
tracked separately by the color-gate repair work.
