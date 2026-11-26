"""Cached build folders may carry third-party output only (#6122)."""

import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

SCRIPT = Path(__file__).with_name("third_party_build_cache.py")
APPLE = SCRIPT.parents[1] / ".github/workflows/apple.yml"
TOOL = "python3 tools/third_party_build_cache.py "
MAIN_ONLY = "github.ref == 'refs/heads/main'"
SPEC = importlib.util.spec_from_file_location("third_party_build_cache", SCRIPT)
cache = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cache)

TARGETS = frozenset(
    (
        "MapleCore",
        "MapleCoreTests",
        "MapleCorePackageTests",
        "RawPipeline",
        "maple-tool",
    )
)
THIRD_PARTY = (
    "checkouts/swift-nio/Package.swift",
    "repositories/swift-nio-1a2b/HEAD",
    "plugins/cache/SwiftProtobufPlugin",
    "plugins/outputs/swift-otel/OTLPCore/SwiftProtobufPlugin/trace.pb.swift",
    "build.db",
    "workspace-state.json",
    "arm64-apple-macosx/release/NIOCore.build/ByteBuffer.swift.o",
    "arm64-apple-macosx/release/CNIOBoringSSL.build/ssl.c.o",
    "arm64-apple-macosx/release/SwiftProtobuf-tool.build/Message.swift.o",
    "arm64-apple-macosx/release/Modules-tool/SwiftProtobuf.swiftmodule",
    ".buildSystem_release",
    "arm64-apple-macosx/release/Modules/NIOCore.swiftmodule",
    "arm64-apple-macosx/release/Modules/GRDB.abi.json",
    "arm64-apple-macosx/release/GRDB_GRDB.bundle/PrivacyInfo.xcprivacy",
    "arm64-apple-macosx/release/swift-version--58304C5D6DBC2206.txt",
)
FIRST_PARTY = (
    "arm64-apple-macosx/release/MapleCore.build/AdjustmentModel.swift.o",
    "arm64-apple-macosx/release/MapleCoreTests.build/CropGeometryTests.swift.o",
    "arm64-apple-macosx/release/MapleCorePackageTests.build/runner.swift.o",
    "arm64-apple-macosx/release/Modules/MapleCore.swiftmodule",
    "arm64-apple-macosx/release/Modules/MapleCore.abi.json",
    "arm64-apple-macosx/release/MapleCore-tool.build/Macro.swift.o",
    "arm64-apple-macosx/release/Modules-tool/MapleCore.swiftmodule",
    "arm64-apple-macosx/release/Modules/MapleCoreTests.swiftdoc",
    "arm64-apple-macosx/release/MapleCore_MapleCore.bundle/builtin-presets.json",
    "arm64-apple-macosx/release/MapleCore_MapleCore-tool.bundle/presets.json",
    "arm64-apple-macosx/release/MapleCore_maple-tool.bundle/presets.json",
    "arm64-apple-macosx/release/maple-tool.build/main.swift.o",
    "arm64-apple-macosx/release/description.json",
    "release.yaml",
    "arm64-apple-macosx/release/MapleCorePackageTests.xctest/Contents/MacOS/Tests",
    "arm64-apple-macosx/release/MapleCorePackageTests.product/Objects.LinkFileList",
    "arm64-apple-macosx/release/libraw_ffi.a",
    "arm64-apple-macosx/release/ModuleCache/ABC123/RawPipeline-1XYZ.pcm",
    "arm64-apple-macosx/release/index/store/v5/units/MapleCore.o-1",
    "arm64-apple-macosx/stray.o",
    "plugins/outputs/maplecore/MapleCore/Generator/Generated.swift",
    "out/Products/Debug/MapleCore.o",
    "index-build/arm64-apple-macosx/debug/MapleCore.build/A.o",
)


class SwiftPMOutputTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.build = Path(directory.name) / ".build"
        for relative in (*THIRD_PARTY, *FIRST_PARTY):
            path = self.build / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(relative)
        (self.build / "release").symlink_to("arm64-apple-macosx/release")

    def remaining(self):
        return {
            path.relative_to(self.build).as_posix()
            for path in self.build.rglob("*")
            if path.is_file() and not path.is_symlink()
        }

    def test_prune_leaves_exactly_the_third_party_output(self):
        for path in cache.swiftpm_first_party_output(self.build, TARGETS):
            cache.remove(path)
        self.assertEqual(self.remaining(), set(THIRD_PARTY))
        self.assertTrue((self.build / "release").is_symlink())
        self.assertEqual(cache.swiftpm_first_party_output(self.build, TARGETS), [])

    def test_a_target_folder_is_first_party_only_by_its_listed_name(self):
        # An unlisted first-party module survives: the target list is the guard.
        listed = frozenset(("MapleCoreTests",))
        removed = {
            path.name for path in cache.swiftpm_first_party_output(self.build, listed)
        }
        self.assertNotIn("MapleCore.build", removed)
        self.assertIn("MapleCoreTests.build", removed)

    def test_the_command_strips_the_named_package_and_flags_a_restored_one(self):
        package = self.build.parent
        with patch.object(cache, "describe_package") as describe:
            describe.return_value = {
                "name": "MapleCore",
                "targets": [{"name": name, "c99name": name} for name in TARGETS],
            }
            for arguments, prefix in (
                (["swiftpm", str(package), "--restored"], r"::warning::Removed [1-9]"),
                (["swiftpm", str(package), "--restored"], r"Removed 0 "),
                (["swiftpm", str(package)], r"Removed 0 "),
                (["swiftpm", str(package / "absent")], r"Removed 0 "),
            ):
                with self.subTest(arguments=arguments):
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        cache.main(arguments)
                    self.assertRegex(output.getvalue(), f"^{prefix}")
        self.assertEqual(self.remaining(), set(THIRD_PARTY))
        describe.assert_called_with(package)
        with self.assertRaises(SystemExit):
            cache.main(["swiftpm"])

    def test_a_missing_build_folder_has_nothing_to_remove(self):
        absent = self.build / "absent"
        self.assertEqual(cache.swiftpm_first_party_output(absent, TARGETS), [])


class SwiftPMTargetTests(unittest.TestCase):
    def test_targets_follow_local_path_dependencies_and_stop_at_remote_ones(self):
        names = ("Core", "Backup", "Smb")
        root, local, nested = (Path(f"/packages/{name}") for name in names)
        descriptions = {
            root: {
                "name": "Core",
                "targets": [
                    {"name": "Core", "c99name": "Core", "type": "library"},
                    {"name": "Core-Tests", "c99name": "Core_Tests", "type": "test"},
                ],
                "dependencies": [
                    {"type": "fileSystem", "path": str(local)},
                    {"type": "sourceControl", "url": "https://example.invalid/nio.git"},
                ],
            },
            local: {
                "name": "Backup",
                "targets": [{"name": "Backup", "c99name": "Backup"}],
                "dependencies": [
                    {"type": "fileSystem", "path": str(nested)},
                    {"type": "fileSystem", "path": str(root)},
                ],
            },
            nested: {"name": "Smb", "targets": [{"name": "Smb", "c99name": "Smb"}]},
        }
        self.assertEqual(
            cache.swiftpm_first_party_targets(
                root, lambda package: descriptions[Path(package)]
            ),
            {
                "Core",
                "Core-Tests",
                "Core_Tests",
                "CorePackageTests",
                "Backup",
                "BackupPackageTests",
                "Smb",
                "SmbPackageTests",
            },
        )

    def test_a_first_party_plugin_or_macro_is_refused(self):
        # The rules have never met a real plugin or macro build.
        for kind in ("plugin", "macro"):
            description = {
                "name": "Core",
                "targets": [{"name": "Gen", "c99name": "Gen", "type": kind}],
            }
            with self.subTest(kind=kind), self.assertRaises(SystemExit):
                cache.swiftpm_first_party_targets(Path("/Core"), lambda _: description)


class CargoOutputTests(unittest.TestCase):
    PACKAGES = frozenset(("serde", "libc", "ring", "md_5"))
    LIBRARIES = frozenset(("serde", "libc", "ring", "md5"))
    THIRD_PARTY = (
        "release/.fingerprint/serde-1a2b/lib-serde",
        "release/.fingerprint/libc-3c4d/lib-libc",
        "release/.fingerprint/md-5-7e8f/lib-md5",
        "release/build/ring-5e6f/out/libring.a",
        "release/build/ring-5e6f/build_script_build-5e6f",
        "release/deps/libserde-1a2b.rlib",
        "release/deps/serde-1a2b.d",
        "release/deps/liblibc-3c4d.rlib",
        "release/deps/libc-3c4d.d",
        "release/deps/libmd5-7e8f.rlib",
        "aarch64-apple-darwin/release/deps/libserde-9f8e.rlib",
        "aarch64-apple-darwin/release/.fingerprint/serde-9f8e/lib-serde",
        "CACHEDIR.TAG",
        ".rustc_info.json",
    )
    FIRST_PARTY = (
        "release/.fingerprint/raw-core-7a8b/lib-raw_core",
        "release/.fingerprint/raw-ffi-9c0d/lib-raw_ffi",
        "release/.fingerprint/codegen-2b3c/bin-codegen",
        "release/build/raw-core-7a8b/out/tables.rs",
        "release/deps/libraw_core-7a8b.rlib",
        "release/deps/raw_core-7a8b.d",
        "release/deps/libraw_ffi-9c0d.a",
        "release/deps/codegen-2b3c",
        "release/deps/export_recipe_interchange-1f2e",
        "release/deps/md_5-7e8f.d",
        "release/libraw_ffi.a",
        "release/libraw_ffi.d",
        "release/examples/export-recipe-interchange",
        "release/incremental/raw_core-abc/s-1/dep-graph.bin",
        "aarch64-apple-darwin/release/deps/libraw_core-5d4c.rlib",
        "aarch64-apple-darwin/release/libraw_ffi.a",
        "aarch64-apple-darwin/CACHEDIR.TAG.bak",
        "doc/raw_core/index.html",
        "tmp/raw-core-scratch",
        "package/raw-core-0.1.0.crate",
    )
    METADATA = {
        "packages": [
            {
                "name": "serde",
                "source": "registry+https://example.invalid/index",
                "targets": [
                    {"name": "serde", "kind": ["lib"]},
                    {"name": "codegen", "kind": ["test"]},
                ],
            },
            {
                "name": "md-5",
                "source": "registry+https://example.invalid/index",
                "targets": [
                    {"name": "md5", "kind": ["lib"]},
                    {"name": "build-script-build", "kind": ["custom-build"]},
                ],
            },
            {
                "name": "serde-derive",
                "source": "git+https://example.invalid/serde",
                "targets": [{"name": "serde_derive", "kind": ["proc-macro"]}],
            },
            {
                "name": "raw-core",
                "source": None,
                "targets": [{"name": "raw_core", "kind": ["lib"]}],
            },
            {
                "name": "codegen",
                "source": None,
                "targets": [{"name": "codegen", "kind": ["bin"]}],
            },
        ]
    }

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.target = Path(directory.name) / "target"
        for relative in (*self.THIRD_PARTY, *self.FIRST_PARTY):
            path = self.target / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(relative)

    def remaining(self):
        return {
            path.relative_to(self.target).as_posix()
            for path in self.target.rglob("*")
            if path.is_file()
        }

    def test_prune_leaves_exactly_the_third_party_crates(self):
        names = (self.PACKAGES, self.LIBRARIES)
        for path in cache.cargo_first_party_output(self.target, *names):
            cache.remove(path)
        self.assertEqual(self.remaining(), set(self.THIRD_PARTY))
        self.assertEqual(cache.cargo_first_party_output(self.target, *names), [])
        absent = self.target / "absent"
        self.assertEqual(cache.cargo_first_party_output(absent, *names), [])

    def test_third_party_names_are_library_targets_no_first_party_crate_shares(self):
        packages, libraries = cache.cargo_third_party_names(self.METADATA)
        self.assertEqual(packages, {"serde", "md_5", "serde_derive"})
        self.assertEqual(libraries, {"serde", "md5", "serde_derive"})
        shadowed = {
            "packages": [
                *self.METADATA["packages"],
                {
                    "name": "raw-ffi",
                    "source": None,
                    "targets": [
                        {"name": "raw_ffi", "kind": ["staticlib"]},
                        {"name": "md5", "kind": ["test"]},
                        {"name": "serde", "kind": ["example"]},
                    ],
                },
            ]
        }
        packages, libraries = cache.cargo_third_party_names(shadowed)
        self.assertEqual(packages, {"md_5", "serde_derive"})
        self.assertEqual(libraries, {"serde_derive"})

    def test_the_command_strips_the_named_target_folder(self):
        metadata = {
            "packages": [
                {
                    "name": name.replace("_", "-"),
                    "source": "registry+https://example.invalid/index",
                    "targets": [
                        {"name": "md5" if name == "md_5" else name, "kind": ["lib"]}
                    ],
                }
                for name in self.PACKAGES
            ]
        }
        with patch.object(cache, "cargo_metadata", return_value=metadata) as load:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                cache.main(["cargo", "workspace", str(self.target)])
        load.assert_called_once_with("workspace")
        self.assertRegex(output.getvalue(), "^Removed [1-9]")
        self.assertEqual(self.remaining(), set(self.THIRD_PARTY))


class AppleWorkflowTests(unittest.TestCase):
    SAVE = f"{MAIN_ONLY} && steps.%s.outputs.cache-hit != 'true'"
    PRUNED = " && steps.swift-prune.outcome == 'success'"

    def setUp(self):
        jobs = yaml.safe_load(APPLE.read_text())["jobs"]
        self.jobs = {name: job.get("steps", []) for name, job in jobs.items()}
        self.steps = [step for steps in self.jobs.values() for step in steps]

    def using(self, action):
        return [step for step in self.steps if step.get("uses", "").startswith(action)]

    def cached(self, package):
        return package.strip('"').replace(
            "$MAPLE_SWIFT_TEST_ROOT", "${{ env.MAPLE_SWIFT_TEST_ROOT }}"
        ) + "/.build"

    def build_folder_steps(self, action):
        return [
            (steps, index)
            for steps in self.jobs.values()
            for index, step in enumerate(steps)
            if step.get("uses", "").startswith(action)
            and ".build" in step["with"]["path"]
        ]

    def test_only_main_saves_a_cache_and_only_under_a_new_key(self):
        # The combined action also saves from pull requests.
        self.assertEqual(self.using("actions/cache@"), [])
        saves = self.using("actions/cache/save@")
        self.assertEqual(len(saves), 4)
        for step in saves:
            with self.subTest(step=step["name"]):
                restore = step["with"]["key"].split(".")[1]
                self.assertEqual(
                    step["with"]["key"],
                    f"${{{{ steps.{restore}.outputs.cache-primary-key }}}}",
                )
                expected = self.SAVE % restore
                self.assertIn(step["if"].removeprefix(expected), ("", self.PRUNED))
        for step in self.using("actions/cache/restore@"):
            self.assertNotIn("restore-keys", step["with"])
        (rust,) = self.using("Swatinem/rust-cache@")
        self.assertEqual(rust["with"]["save-if"], f"${{{{ {MAIN_ONLY} }}}}")
        self.assertEqual(rust["with"]["workspaces"], "src/raw-pipeline -> target")
        self.assertEqual(
            set(rust["with"]),
            {"workspaces", "key", "env-vars", "cache-bin", "save-if"},
        )
        self.assertEqual(rust["with"]["env-vars"], "MACOSX_DEPLOYMENT_TARGET")
        for hashed in ("src/raw-pipeline/Cargo.toml", "third_party/*/Cargo.toml"):
            self.assertIn(hashed, rust["with"]["key"])
        installs = [
            step["run"]
            for step in self.jobs["swift-regressions"]
            if "cargo install" in step.get("run", "")
        ]
        self.assertEqual(len(installs), 1)
        self.assertTrue(installs[0].startswith('CARGO_TARGET_DIR="$RUNNER_TEMP/'))

    def test_a_restored_build_folder_is_stripped_before_anything_builds(self):
        restores = self.build_folder_steps("actions/cache/restore@")
        self.assertEqual(len(restores), 2)
        for steps, index in restores:
            with self.subTest(step=steps[index]["name"]):
                strip = steps[index + 1]
                package = strip["run"].removeprefix(TOOL + "swiftpm ").split()[0]
                self.assertEqual(strip["run"], f"{TOOL}swiftpm {package} --restored")
                self.assertIn(self.cached(package), steps[index]["with"]["path"])
                self.assertFalse({"if", "continue-on-error"} & set(strip))
        rust_job = self.jobs["swift-regressions"]
        index = next(
            index
            for index, step in enumerate(rust_job)
            if step.get("uses", "").startswith("Swatinem/rust-cache@")
        )
        self.assertEqual(
            rust_job[index + 1]["run"],
            f'{TOOL}cargo src/raw-pipeline "$CARGO_TARGET_DIR" --restored',
        )
        self.assertFalse({"if", "continue-on-error"} & set(rust_job[index + 1]))
        self.assertIn(
            'CARGO_TARGET_DIR=$GITHUB_WORKSPACE/src/raw-pipeline/target"',
            "".join(step.get("run", "") for step in rust_job[:index]),
        )

    def test_a_swift_build_folder_is_stripped_before_it_is_saved(self):
        saves = self.build_folder_steps("actions/cache/save@")
        self.assertEqual(len(saves), 2)
        for steps, index in saves:
            save, strip = steps[index], steps[index - 1]
            with self.subTest(step=save["name"]):
                package = strip["run"].removeprefix(TOOL + "swiftpm ")
                self.assertEqual(strip["run"], f"{TOOL}swiftpm {package}")
                self.assertNotIn("--restored", package)
                self.assertNotIn("if", strip)
                self.assertIn(self.cached(package), save["with"]["path"])
                self.assertEqual(
                    save["if"],
                    f"{self.SAVE % 'swift-cache'} && "
                    f"steps.{strip['id']}.outcome == 'success'",
                )
                restore = next(
                    step for step in steps if step.get("id") == "swift-cache"
                )
                self.assertEqual(save["with"]["path"], restore["with"]["path"])
                hashed = ("MapleCore", "MapleBackup", "MapleMCP", "AMSMB2")
                for name in (SCRIPT.name, ".resolved", "steps.xcode.outputs.build"):
                    self.assertIn(name, restore["with"]["key"])
                for name in hashed:
                    self.assertIn(f"{name}/Package.swift", restore["with"]["key"])

    def test_the_pinned_toolchain_is_installed_before_the_first_cargo_call(self):
        cargo_jobs = {
            name: [
                index
                for index, step in enumerate(steps)
                if "cargo " in step.get("run", "")
                or "cbindgen " in step.get("run", "")
                or step.get("uses", "").startswith("Swatinem/rust-cache@")
            ]
            for name, steps in self.jobs.items()
        }
        self.assertEqual(
            {name for name, calls in cargo_jobs.items() if calls},
            {"swift-build", "swift-regressions"},
        )
        for name, calls in cargo_jobs.items():
            if calls:
                with self.subTest(job=name):
                    steps = self.jobs[name]
                    install = next(
                        index
                        for index, step in enumerate(steps)
                        if "rustup toolchain install" in step.get("run", "")
                    )
                    self.assertLess(install, calls[0])
                    self.assertEqual(
                        steps[install]["working-directory"], "src/raw-pipeline"
                    )
                    self.assertIn("for attempt in 1 2 3", steps[install]["run"])


if __name__ == "__main__":
    unittest.main()
