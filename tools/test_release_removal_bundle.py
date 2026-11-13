"""Offline removal packaging integrity against real files/archives (#1472)."""

import copy
import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from removal import mac_model_bundle as bundle


def sha(data):
    return hashlib.sha256(data).hexdigest()


class RemovalBundleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.exports = self.root / "exports"
        self.output = self.root / "offline"
        self.archive = self.root / "runtime.tgz"
        self.review = {
            "release_qualified": False,
            "public_distribution_approved": False,
            "exports": {},
            "additional_notices": [],
        }
        self.pins = []
        for role in ("lama", "encoder", "decoder", "detector"):
            data = f"test packaging bytes {role}".encode()
            checkpoint = sha(f"checkpoint {role}".encode())
            license_data = f"original {role} notice\n".encode()
            pin = {
                "id": role,
                "file": f"{role}.onnx",
                "probe_path": f"{role}/{role}.onnx",
                "sha256": sha(data),
                "size": len(data),
                "source_revision": role,
                "checkpoint_sha256": checkpoint,
                "release_qualified": False,
            }
            source = self.exports / pin["probe_path"]
            source.parent.mkdir(parents=True)
            source.write_bytes(data)
            (source.parent / "LICENSE").write_bytes(license_data)
            metadata = {
                "artifact_sha256": pin["sha256"],
                "source_revision": role,
                "release_qualified": False,
            }
            if role in ("encoder", "decoder"):
                metadata["source_digests"] = {"weights/mobile_sam.pt": checkpoint}
            else:
                metadata["checkpoint_sha256"] = checkpoint
            metadata_path = source.with_suffix(".json")
            bundle.write_json(metadata_path, metadata)
            self.pins.append(pin)
            self.review["exports"][role] = {
                "metadata_sha256": bundle.digest(metadata_path),
                "license_file": "LICENSE",
                "license_sha256": sha(license_data),
            }
        notice = self.root / "transitive-LICENSE"
        notice.write_bytes(b"original transitive license\n")
        self.review["additional_notices"] = [
            {"file": notice.name, "sha256": bundle.digest(notice)}
        ]
        self.runtime_bytes = b"test runtime bytes"
        self.members = {
            "runtime/lib/libonnxruntime.version.dylib": self.runtime_bytes,
            "runtime/LICENSE": b"Runtime license\n",
            "runtime/ThirdPartyNotices.txt": b"Runtime third-party notices\n",
            "runtime/Privacy.md": b"Privacy\n",
            "runtime/VERSION_NUMBER": b"testing-version\n",
            "runtime/GIT_COMMIT_ID": b"testing-source\n",
        }
        self.links = {
            "runtime/lib/libonnxruntime.dylib": "libonnxruntime.version.dylib"
        }
        self.runtime = {
            "architecture": "test",
            "installed_sha256": sha(self.runtime_bytes),
            "internal_path": "runtime/lib/libonnxruntime.dylib",
        }
        self.write_archive()

    def write_archive(self, duplicate=False, prefix=""):
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data in self.members.items():
                member = tarfile.TarInfo(prefix + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            for name, target in self.links.items():
                member = tarfile.TarInfo(prefix + name)
                member.type = tarfile.SYMTYPE
                member.linkname = target
                archive.addfile(member)
                if duplicate:
                    archive.addfile(member)
        self.runtime["archive_sha256"] = bundle.digest(self.archive)
        self.runtime["archive_size"] = self.archive.stat().st_size

    def build(self):
        return bundle.build_bundle(
            self.exports,
            self.archive,
            self.output,
            self.pins,
            self.runtime,
            self.review,
            self.root,
        )

    def assert_refused(self):
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.build()
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob(".maple-model-bundle-*")), [])

    def test_complete_bundle_regular_runtime_notices_and_inventory(self):
        self.build()
        self.assertEqual(
            (self.output / "runtime.dylib").read_bytes(), self.runtime_bytes
        )
        self.assertFalse((self.output / "runtime.dylib").is_symlink())
        manifest = json.loads((self.output / "bundle.json").read_text())
        self.assertFalse(manifest["release_qualified"])
        self.assertFalse(manifest["public_distribution_approved"])
        for record in manifest["files"]:
            bundle.verify(
                self.output / record["file"], record["sha256"], record["size"]
            )
        for name in (
            "LICENSE",
            "ThirdPartyNotices.txt",
            "Privacy.md",
            "VERSION_NUMBER",
            "GIT_COMMIT_ID",
        ):
            self.assertEqual(
                (self.output / "provenance/runtime" / name).read_bytes(),
                self.members[f"runtime/{name}"],
            )
        self.assertEqual(
            (self.output / "provenance/transitive-LICENSE").read_bytes(),
            (self.root / "transitive-LICENSE").read_bytes(),
        )

    def test_same_size_model_tamper_refused(self):
        source = self.exports / self.pins[1]["probe_path"]
        source.write_bytes(b"x" * source.stat().st_size)
        self.assert_refused()

    def test_incomplete_model_set_refused(self):
        (self.exports / self.pins[3]["probe_path"]).unlink()
        self.assert_refused()

    def test_metadata_tamper_and_wrong_provenance_refused(self):
        source = self.exports / self.pins[0]["probe_path"]
        path = source.with_suffix(".json")
        metadata = json.loads(path.read_text())
        metadata["source_revision"] = "untrusted revision"
        bundle.write_json(path, metadata)
        self.assert_refused()
        # Even an updated review digest cannot bind a different source to a pin.
        self.review["exports"]["lama"]["metadata_sha256"] = bundle.digest(path)
        self.assert_refused()

    def test_license_tamper_refused(self):
        (self.exports / "encoder/LICENSE").write_bytes(b"altered notice")
        self.assert_refused()

    def test_wrong_runtime_archive_and_dylib_refused(self):
        original = copy.deepcopy(self.runtime)
        self.runtime["archive_sha256"] = "0" * 64
        self.assert_refused()
        self.runtime = original
        self.runtime["installed_sha256"] = "0" * 64
        self.assert_refused()

    def test_missing_third_party_runtime_notice_refused(self):
        del self.members["runtime/ThirdPartyNotices.txt"]
        self.write_archive()
        self.assert_refused()

    def test_archive_symlink_escape_and_cycle_refused(self):
        self.links["runtime/lib/libonnxruntime.dylib"] = "../../outside"
        self.write_archive()
        self.assert_refused()
        self.links["runtime/lib/libonnxruntime.dylib"] = "libonnxruntime.dylib"
        self.write_archive()
        self.assert_refused()

    def test_duplicate_archive_members_refused(self):
        self.write_archive(duplicate=True)
        self.assert_refused()

    def test_official_style_dot_prefixed_paths_work(self):
        self.write_archive(prefix="./")
        self.build()
        self.assertEqual(
            (self.output / "runtime.dylib").read_bytes(), self.runtime_bytes
        )

    def test_bundle_inventory_is_reproducible_across_destinations(self):
        self.build()
        original = (self.output / "bundle.json").read_bytes()
        self.output = self.root / "second-offline"
        self.build()
        self.assertEqual((self.output / "bundle.json").read_bytes(), original)

    def test_missing_transitive_notice_refused(self):
        (self.root / "transitive-LICENSE").unlink()
        self.assert_refused()

    def test_existing_output_preserved_including_symlink(self):
        self.output.mkdir()
        marker = self.output / "marker"
        marker.write_bytes(b"existing contents")
        with self.assertRaises(ValueError):
            self.build()
        self.assertEqual(marker.read_bytes(), b"existing contents")
        marker.unlink()
        self.output.rmdir()
        self.output.symlink_to(self.root / "nonexistent-target")
        with self.assertRaises(ValueError):
            self.build()
        self.assertTrue(self.output.is_symlink())

    def test_release_flags_cannot_be_approved_by_testing_builder(self):
        for container, field in (
            (self.review, "public_distribution_approved"),
            (self.review, "release_qualified"),
            (self.pins[0], "release_qualified"),
        ):
            container[field] = True
            self.assert_refused()
            container[field] = False

    def test_traversal_in_notice_and_generated_probe_path_refused(self):
        original = self.review["additional_notices"][0]["file"]
        self.review["additional_notices"][0]["file"] = "../outside"
        self.assert_refused()
        self.review["additional_notices"][0]["file"] = original
        self.pins[0]["probe_path"] = "../outside.onnx"
        self.assert_refused()


if __name__ == "__main__":
    unittest.main()
