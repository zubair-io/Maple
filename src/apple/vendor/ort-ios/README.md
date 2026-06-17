# Vendored ONNX Runtime iOS static xcframework

| Field         | Value                                                                 |
| ------------- | --------------------------------------------------------------------- |
| Artifact      | `pod-archive-onnxruntime-c-1.22.0.zip`                               |
| ORT version   | 1.22.0 (pairs with `ort = "=2.0.0-rc.10"` in the Cargo workspace)    |
| SHA-256       | `90d9de5a139087a6b05a18125d01d01d198820e1731e6f0f11b38749b2ab181f`   |
| Upstream URL  | `https://download.onnxruntime.ai/pod-archive-onnxruntime-c-1.22.0.zip` |

## Why it is vendored here

`fetch-ort-ios.sh` previously downloaded this zip from `download.onnxruntime.ai`
at build time. Xcode Cloud workers hit intermittent DNS timeouts against that
host, causing the iOS slice of `build-xcframework.sh` to fail non-deterministically.

The zip is 45 MB, comfortably under GitHub's 50 MB per-file warning and 100 MB
hard limit, so it is committed directly (no Git LFS required).

## How it is consumed

`fetch-ort-ios.sh` copies this zip into `~/.cache/maple-pano/ort-ios/` and
verifies its SHA-256 before extracting. No network access is required or
attempted. The extracted xcframework provides the static `onnxruntime.a` that
`build-xcframework.sh` links into the iOS and iOS-sim raw-ffi slices.

## Version bumps

To upgrade ORT:
1. Download the new pod archive from the upstream URL pattern above.
2. Compute its SHA-256 (`shasum -a 256 <file>`).
3. Replace this file, update the SHA in this README, and update `ORT_VERSION`
   + `ORT_ZIP_SHA256` in `../scripts/fetch-ort-ios.sh`.
4. Bump the `ort` crate version in `src/raw-pipeline/Cargo.toml` to match.
