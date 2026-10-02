#!/usr/bin/env bash
# #4035: Rust → generated Swift → generated Web/API TS → Rust, on real XMP.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/maple-workflow-contract.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
cd "$repo_root"
cargo build --manifest-path src/raw-pipeline/Cargo.toml -p raw-core --example workflow-contract
rust_bin="$repo_root/src/raw-pipeline/target/debug/examples/workflow-contract"
swiftc src/apple/Packages/MapleCore/Sources/MapleCore/Generated/Workflow+Generated.swift \
	tools/qualification/workflow/roundtrip.swift -o "$work_dir/swift-roundtrip"
"$rust_bin" <test-fixtures/workflow/contract-v1.json >"$work_dir/rust-before.json"
"$work_dir/swift-roundtrip" <"$work_dir/rust-before.json" >"$work_dir/swift.json"
bun tools/qualification/workflow/roundtrip.ts <"$work_dir/swift.json" >"$work_dir/ts.json"
"$rust_bin" <"$work_dir/ts.json" >"$work_dir/rust-after.json"
cmp "$work_dir/rust-before.json" "$work_dir/rust-after.json"
echo 'workflow-contract: Rust → Swift → Web/API → Rust passed; complete checkpoint bytes preserved'
