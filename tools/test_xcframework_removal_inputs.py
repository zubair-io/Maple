"""#3941: actual Apple hash must invalidate on native removal crate edits.

Only exercises input hashing in isolated trees, without compiling or claiming
any dummy framework is a usable binary. No user checkout or library is changed.
"""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "src/apple/scripts/build-xcframework.sh"


class XcframeworkRemovalInputTests(unittest.TestCase):
    def fixture(self, directory):
        native = directory / "src/apple"
        scripts = native / "scripts"
        scripts.mkdir(parents=True)
        pipeline = directory / "src/raw-pipeline"
        pipeline.mkdir()
        (pipeline / "Cargo.toml").write_text("[workspace]\nmembers = []\n")
        (pipeline / "Cargo.lock").write_text("version = 4\n")
        for crate in ("raw-core", "raw-ffi", "raw-gpu", "maple-pano", "maple-removal"):
            source = pipeline / crate / "src"
            source.mkdir(parents=True)
            (source / "lib.rs").write_text("pub fn version() -> u32 { 1 }\n")
            (source.parent / "Cargo.toml").write_text(f'[package]\nname = "{crate}"\n')
        (pipeline / "raw-ffi/cbindgen.toml").write_text('language = "C"\n')
        shutil.copyfile(
            ROOT / "src/apple/scripts/fetch-ort-ios.sh", scripts / "fetch-ort-ios.sh"
        )
        # Execute the real script up to and including INPUT_HASH computation.
        # Its subsequent compiler/provisioning code is outside this test's scope.
        text = SCRIPT.read_text()
        marker = '\nINPUT_HASH="$(compute_input_hash)"\n'
        self.assertEqual(text.count(marker), 1)
        prefix = text[: text.index(marker) + len(marker)]
        probe = scripts / "build-xcframework.sh"
        probe.write_text(prefix + 'printf "%s\\n" "$INPUT_HASH"\n')
        return pipeline, probe

    def digest(self, probe):
        result = subprocess.run(
            ["bash", str(probe)], check=True, capture_output=True, text=True
        )
        digest = result.stdout.strip()
        self.assertRegex(digest, r"^[0-9a-f]{40}$")
        return digest

    def test_removal_source_change_and_addition_invalidate_actual_apple_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            pipeline, probe = self.fixture(Path(temporary))
            source = pipeline / "maple-removal/src/lib.rs"
            before = self.digest(probe)
            source.write_text("pub fn version() -> u32 { 2 }\n")
            changed = self.digest(probe)
            self.assertNotEqual(before, changed)
            extra = source.with_name("native_decoder.rs")
            extra.write_text("pub fn native_extent() -> u32 { 1024 }\n")
            self.assertNotEqual(changed, self.digest(probe))
            extra.unlink()
            self.assertEqual(changed, self.digest(probe))

    def test_removal_dependency_change_invalidates_without_source_edits(self):
        with tempfile.TemporaryDirectory() as temporary:
            pipeline, probe = self.fixture(Path(temporary))
            before = self.digest(probe)
            manifest = pipeline / "maple-removal/Cargo.toml"
            manifest.write_text(manifest.read_text() + "[features]\nml = []\n")
            self.assertNotEqual(before, self.digest(probe))

    def test_unrelated_document_change_does_not_invalidate_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            pipeline, probe = self.fixture(Path(temporary))
            before = self.digest(probe)
            (pipeline / "maple-removal/README.md").write_text("Research notes\n")
            self.assertEqual(before, self.digest(probe))


if __name__ == "__main__":
    unittest.main()
