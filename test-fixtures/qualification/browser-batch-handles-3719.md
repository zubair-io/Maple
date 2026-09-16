# Cloneable browser batch fixtures — #3719

## Result

The complete Hosted Browse/Preview actions test passes in installed Chrome using native FileSystemDirectoryHandle/FileSystemFileHandle objects backed by disposable Origin Private File System (OPFS) storage. Copy/Paste and Sync execute the production batch worker and persist real browser sidecars; no production code or worker transport is replaced.

Production artifact: 9e601f937 plus #3720 observability changes, built before this test-only change. Current main 29dd1fad changes API backup/location code only; Web/Rust are identical. Chrome 152, macOS/Darwin 25.6, Apple M5 Max. This is functional qualification, not performance evidence.

## Why the fixture changed

The former injected JavaScript handle had async methods and failed Worker.postMessage structured cloning. A real native handle is cloneable and can also persist in IndexedDB. The new boundary supplies Chrome's own handles, stages only reset root files through bounded 4 MiB transfers and checks SHA256 before returning the folder. Original host fixtures are opened read-only. Writes and reads for assertions use actual browser files.

The existing host-filesystem bridge remains for cache timing, read auditing and injected permission-denial/recovery coverage. Those uses do not claim native worker-handle coverage. OPFS is not an externally mounted directory and does not test OS picker grants, share disconnection or performance; this helper is scoped to the batch worker's real handle/sidecar persistence contract.

## Executed evidence

- Before: old bridge reached Paste and Chrome reported DataCloneError for the injected queryPermission function; target sidecar stayed unchanged.
- Native bridge: real Copy/Paste wrote target Exposure2012=1.25. The first subsequent Sync check exposed a stale test expectation: Sync opens selective-paste confirmation. The test now confirms that visible dialog for one target.
- Complete Browse actions pass: 6.7s. Includes fresh durable writes for both Paste and Sync (target XMP reset between them), filters and rating shortcuts, tablet overflow, filmstrip selection/keyboard/navigation, info and flag controls, actual reject flag persistence, no Hosted API requests, browser RAW SHA256 revalidation and host original/staged RAW SHA256 checks.
- Browse single-file import → Preview → Edit also passed 3.6s with the new helper present; that test still uses the actual file input.
- Focused TypeScript compilation and changed-file fallow audit pass.

No sidecar mock, worker bypass, original modification, relaxed threshold or disabled assertion was introduced. The #3720 report's Browse Copy/Paste fixture limitation is resolved by this change; its separate Self Hosted runtime qualification gap was subsequently closed by the run below.

## Follow-up Self Hosted runtime qualification

The #3720 branch was also built as the Self Hosted production app, with a freshly compiled release raw-ffi (`gpu,pano`), a disposable MongoMemoryServer database and an isolated API on port 4775. Installed Chrome passed the real RAW reliability flow in 6.5s: X3F thumbnail/preview/editor, RAF preview, named one-shot HTTP 403 byte failure, visible retry, restored nonblank pixels and pixels after reload. Original/staged hashes passed; no existing database or user assets were used. This closes the initial #3720 report's locally unexecuted Self Hosted qualification gap.
