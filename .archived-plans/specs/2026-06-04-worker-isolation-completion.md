# Worker Isolation Completion — Inline Native Removal

**Date:** 2026-06-04
**Issue:** #884
**Related:** #897 (bounds damage but doesn't remove the abort)
**Related:** #882 (original grandchild pool isolation work)

## Problem

After #897, worker-main still held inline-abortable native code in its address space:

1. **thumbnailer.ts** called `applyExifOrientationInPlace` inline, which imports `sharp`
2. **previewer.ts** called `applyExifOrientationInPlace` inline, which imports `sharp`

These inline sharp imports meant a malformed asset (corrupt JPEG, huge TIFF that triggers a libvips assertion) could SIGABRT the entire worker tier, taking down all 8 stages' in-flight work.

## Architecture Before Fix

```
worker-main process
├── thumb stage → thumbnailer.ts
│   ├── RAW: ffiPool() → child process ✓
│   ├── Bitmap: imgdecode-pool → child process ✓
│   └── Post-process: applyExifOrientationInPlace() → INLINE SHARP ✗
│
├── preview stage → previewer.ts
│   ├── RAW: ffiPool() → child process ✓
│   ├── Bitmap: imgdecode-pool → child process ✓
│   └── Post-process: applyExifOrientationInPlace() → INLINE SHARP ✗
│
└── face stages → face-pool
    ├── Normal: face-pool.child.ts → child process ✓
    └── Fallback: OnnxFaceDetector → IN-PROCESS (documented)
```

## Solution

Remove the inline `applyExifOrientationInPlace` calls entirely. Orientation is already handled correctly in the isolated child processes:

- **RAW path (ffi-pool)**: The Rust FFI bakes orientation into pixels during embedded-preview extraction. The output JPEG has no EXIF orientation tag.
- **Bitmap path (imgdecode-pool)**: The child process calls `sharp(...).rotate()` at decode time (render.ts lines 71, 111), which physically rotates pixels and strips the orientation tag.

The inline post-process was "defense-in-depth" that turned out to be redundant AND dangerous (loads sharp in worker-main).

## Architecture After Fix

```
worker-main process
├── thumb stage → thumbnailer.ts
│   ├── RAW: ffiPool() → child process ✓
│   └── Bitmap: imgdecode-pool → child process ✓
│   (no post-process, orientation baked at decode)
│
├── preview stage → previewer.ts
│   ├── RAW: ffiPool() → child process ✓
│   └── Bitmap: imgdecode-pool → child process ✓
│   (no post-process, orientation baked at decode)
│
└── face stages → face-pool
    ├── Normal: face-pool.child.ts → child process ✓
    └── Fallback: OnnxFaceDetector → IN-PROCESS (documented)
```

## Face-Pool Exception

The face-pool imports `OnnxFaceDetector` (which imports sharp), but:
- **Normal case**: Runs in `face-pool.child.ts` (isolated child process) ✓
- **Fallback case**: When `Bun.spawn` fails, runs in-process (documented trade-off)

The fallback is intentional — keeps face detection working in no-Worker environments (CI shells, sandboxes) at the cost of re-introducing event-loop blocking. A face-related crash would still abort worker-main in this case, but:
1. The fallback only triggers when child spawn fails (rare)
2. It's explicitly documented as a degradation (face-pool.ts lines 91-95)
3. The normal production path is always isolated

## Changes

1. **thumbnailer.ts**:
   - Removed import of `applyExifOrientationInPlace`
   - Removed inline call after FFI rendering (lines 141-154 → simplified to 131-140)
   - Added comment explaining orientation is baked at decode time

2. **previewer.ts**:
   - Removed import of `applyExifOrientationInPlace`
   - Removed inline call after FFI rendering (lines 165-177 → simplified to 154-166)
   - Added comment explaining orientation is baked at decode time

3. **thumb.ts**:
   - Updated header comment to reflect new isolation architecture

4. **check-worker-isolation.sh**:
   - New CI-ready validation script
   - Checks for inline sharp/onnxruntime/heic-convert imports
   - Verifies thumbnailer/previewer route through pools
   - Documents the face-pool fallback exception

## Verification

Run the check script:
```bash
src/api/scripts/check-worker-isolation.sh
```

Expected output:
```
✓ All checks passed
Worker-main has no inline-abortable native imports.
All heavy native code (sharp, onnxruntime, heic-convert) is isolated in child processes.
```

## Testing Strategy

The change is a **removal** of redundant code, not new behavior:
1. Orientation was already baked at decode time (FFI and imgdecode child)
2. The inline post-process was a no-op (FFI output has no EXIF tag)
3. Bitmap path already called `.rotate()` in the child

### Manual Test with Malformed Asset

To verify a malformed asset no longer crashes worker-main:
1. Place a poison JPEG (corrupt header, oversized, assertion trigger) in a library
2. Let the thumb stage process it
3. Observe: the imgdecode child crashes/rejects, thumb stage retries/dead-letters
4. Verify: other stages keep running (no worker-main abort)

## Related Work

- **#882**: Original grandchild pool isolation (ffi-pool, imgdecode-pool)
- **#897**: Bounds damage from inline onnx/sharp (improves but doesn't remove)
- **#884**: This PR — completes isolation by removing inline sharp calls

## Remaining Abortable Paths

After this fix, the ONLY abortable native in worker-main's address space is the face-pool in-process fallback (when child spawn fails). This is:
- Rare (only when `Bun.spawn` unavailable)
- Documented (face-pool.ts lines 91-95)
- Acceptable (keeps face detection working in no-Worker environments)

The normal production path (child spawn succeeds) is 100% isolated.
