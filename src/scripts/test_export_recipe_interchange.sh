#!/usr/bin/env bash
# Required Rust -> real Swift store -> real Chromium IndexedDB -> Rust gate (#4207).
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
if [[ $# != 3 ]]; then
	echo "Usage: $0 NEW_ARTIFACT_DIRECTORY EXACT_SOURCE_LIBRAW_FFI MATCHING_HEADERS" >&2
	exit 2
fi
artifacts=$1
archive=$2
headers=$3
[[ $(uname -s) == Darwin ]] || {
	echo "Actual Swift/native qualification requires macOS" >&2
	exit 1
}
[[ -f "$archive" && -f "$headers/RawPipeline.h" && -f "$headers/module.modulemap" ]] || {
	echo "Matching real native archive and headers are required; no skip" >&2
	exit 1
}
mkdir "$artifacts"
artifacts=$(cd "$artifacts" && pwd)
archive=$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")
headers=$(cd "$headers" && pwd)
manifest="$repo_root/test-fixtures/export-recipes/interchange-cases.json"
(
	cd "$repo_root/src/raw-pipeline"
	cargo run --locked --release -p raw-core --example export-recipe-interchange -- emit "$artifacts" "$manifest"
) >"$artifacts/rust-emit.log" 2>&1
source_root="$repo_root/src/apple/Packages/MapleCore/Sources/MapleCore"
xcrun swiftc -swift-version 5 -parse-as-library \
	"$repo_root/src/scripts/qualification/recipe-interchange.swift" \
	"$source_root/Generated/ExportRecipe+Generated.swift" \
	"$source_root/ExportRecipes/NativeExportRecipeBridge.swift" \
	"$source_root/ExportRecipes/NativeExportRecord.swift" \
	"$source_root/ExportRecipes/NativeExportStorage.swift" \
	"$source_root/ExportRecipes/NativeExportArtifacts.swift" \
	-I "$headers" "$archive" \
	-framework Accelerate -framework Metal -framework CoreGraphics \
	-framework CoreVideo -framework QuartzCore -framework Foundation -framework Security -lc++ \
	-o "$artifacts/swift-interchange" >"$artifacts/swift-build.log" 2>&1
"$artifacts/swift-interchange" "$artifacts" >"$artifacts/swift-store.log" 2>&1
(
	cd "$repo_root/src/web"
	MAPLE_RECIPE_INTERCHANGE_ARTIFACTS="$artifacts" \
		bun x playwright test --config playwright.recipe-interchange.config.ts
) >"$artifacts/browser.log" 2>&1
(
	cd "$repo_root/src/raw-pipeline"
	cargo run --locked --release -p raw-core --example export-recipe-interchange -- verify "$artifacts"
) >"$artifacts/rust-verify.log" 2>&1
python3 - "$repo_root" "$artifacts" "$archive" "$headers" <<'PY'
import hashlib, json, pathlib, subprocess, sys
root, out, archive, headers = map(pathlib.Path, sys.argv[1:])
result = json.loads((out / 'result.json').read_text())
assert result['fourLegCases'] == 20 and result['rustMalformedRejected'] == 8
assert len(result['legs']) == 2 and result['fieldCount'] == 14
assert all(leg['semantic'] == 20 and leg['supported'] == 7 and
           leg['unsupported'] == 13 and leg['malformedRejected'] == 8 for leg in result['legs'])
def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()
proof = {
    'sourceRevision': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(),
    'manifestSha256': sha(root / 'test-fixtures/export-recipes/interchange-cases.json'),
    'nativeArchiveSha256': sha(archive),
    'nativeHeaderSha256': sha(headers / 'RawPipeline.h'),
    'mirrorDigests': {name: sha(root / path) for name, path in {
        'rustSource': 'src/raw-pipeline/raw-core/src/export_recipe/mod.rs',
        'swift': 'src/apple/Packages/MapleCore/Sources/MapleCore/Generated/ExportRecipe+Generated.swift',
        'typescript': 'src/web/projects/maple-common/src/lib/generated/export-recipe.generated.ts',
    }.items()},
    'artifacts': {name: sha(out / name) for name in ['rust.json', 'swift.json', 'browser.json']},
    'result': result,
}
(out / 'provenance.json').write_text(json.dumps(proof, indent=2) + '\n')
print('Recipe interchange PASS: exact 20 four-leg cases; 8 malformed per decoder; real Swift + IndexedDB')
PY
