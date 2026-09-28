"""Structural regression gates for native package binary reuse (#3872)."""

import ast
import fnmatch
import itertools
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
BUILD_JOBS = ("build-linux", "build-macos", "build-windows")
HELPER = "python tools/native_package_cache.py"
FINGERPRINT = "${{ steps.native-fingerprint.outputs.fingerprint }}"
NATIVE_LIB = "${{ github.workspace }}/src/maple/npm/linux-x64-gnu/libraw_ffi.so"


def enabled(expression, context, success=True):
    """Evaluate the small Actions guard subset here, including implicit success()."""
    source = expression.removeprefix("${{").removesuffix("}}")
    status_check = re.search(r"\b(success|always|failure|cancelled)\s*\(", source)
    for name, value in context.items():
        source = source.replace(name, repr(value))
    source = re.sub(
        r"!(?!=)", " not ", source.replace("&&", " and ").replace("||", " or ")
    )

    def visit(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.BoolOp):
            values = [visit(value) for value in node.values]
            return all(values) if isinstance(node.op, ast.And) else any(values)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not visit(node.operand)
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, right = visit(node.left), visit(node.comparators[0])
            if isinstance(node.ops[0], ast.Eq):
                return left == right
            if isinstance(node.ops[0], ast.NotEq):
                return left != right
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id == "startsWith" and len(node.args) == 2:
                return visit(node.args[0]).startswith(visit(node.args[1]))
            if not node.args and node.func.id in (
                "success",
                "always",
                "failure",
                "cancelled",
            ):
                return {
                    "success": success,
                    "always": True,
                    "failure": not success,
                    "cancelled": False,
                }[node.func.id]
        raise AssertionError(f"Unsupported guard syntax: {ast.dump(node)}")

    result = bool(visit(ast.parse(source.strip(), mode="eval").body))
    return result and (success or bool(status_check))


class NativeWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.config = yaml.safe_load(
            (ROOT / ".github/workflows/publish-package.yml").read_text()
        )
        self.jobs = self.config["jobs"]

    def one_step(self, job, **fields):
        matches = [
            step
            for step in self.jobs[job]["steps"]
            if all(step.get(key) == value for key, value in fields.items())
        ]
        self.assertEqual(len(matches), 1, (job, fields))
        return matches[0]

    def command_step(self, job, command):
        matches = [
            step for step in self.jobs[job]["steps"] if command in step.get("run", "")
        ]
        self.assertEqual(len(matches), 1, (job, command))
        return matches[0]

    def test_restore_is_exact_and_only_for_ordinary_pull_requests(self):
        for job in BUILD_JOBS:
            with self.subTest(job=job):
                self.assertNotIn("if", self.jobs[job])
                restore = self.one_step(job, uses="actions/cache/restore@v4")
                self.assertEqual(restore["id"], "native-cache")
                self.assertIs(restore["continue-on-error"], True)
                # No restore-keys, fallback prefixes, or combined cache action
                # that could implicitly save binaries from a PR.
                self.assertEqual(
                    restore["with"],
                    {
                        "path": ".native-package-cache",
                        "key": "${{ steps.native-fingerprint.outputs.key }}",
                    },
                )
                cache_actions = [
                    step["uses"]
                    for step in self.jobs[job]["steps"]
                    if step.get("uses", "").startswith("actions/cache")
                ]
                self.assertEqual(
                    cache_actions,
                    ["actions/cache/restore@v4", "actions/cache/save@v4"],
                )
                verify = self.one_step(job, id="native-restore")
                self.assertIs(verify["continue-on-error"], True)
                for event, head, outcome, key, hit in itertools.product(
                    (
                        "pull_request",
                        "push",
                        "workflow_dispatch",
                        "workflow_call",
                        "pull_request_target",
                    ),
                    ("feature/cache", "release/next-v0.1.6", "release/next-v"),
                    ("success", "failure", "skipped"),
                    ("exact-key", ""),
                    ("true", "false", ""),
                ):
                    context = {
                        "github.event_name": event,
                        "github.head_ref": head,
                        "steps.native-fingerprint.outcome": outcome,
                        "steps.native-fingerprint.outputs.key": key,
                        "steps.native-cache.outputs.cache-hit": hit,
                    }
                    ordinary = event == "pull_request" and not head.startswith(
                        "release/next-v"
                    )
                    can_restore = ordinary and outcome == "success" and bool(key)
                    self.assertEqual(
                        enabled(restore["if"], context), can_restore, context
                    )
                    # Only successful fingerprinting can produce a real hit.
                    if can_restore:
                        self.assertEqual(
                            enabled(verify["if"], context), hit == "true", context
                        )
                    elif not ordinary:
                        self.assertFalse(enabled(verify["if"], context), context)

    def test_helper_receives_matching_target_platform_and_fingerprint(self):
        for job in BUILD_JOBS:
            with self.subTest(job=job):
                steps = self.jobs[job]["steps"]
                target, platform = (
                    ("x86_64-pc-windows-msvc", "win32-x64-msvc")
                    if job == "build-windows"
                    else ("${{ matrix.target }}", "${{ matrix.platform_dir }}")
                )
                arguments = f"--target {target} --platform {platform}"
                fingerprint = self.one_step(job, id="native-fingerprint")
                self.assertNotIn("if", fingerprint)
                self.assertIs(fingerprint["continue-on-error"], True)
                self.assertEqual(
                    fingerprint["run"].strip(),
                    f'{HELPER} fingerprint {arguments} --github-output "$GITHUB_OUTPUT"',
                )
                restore = self.one_step(job, id="native-restore")
                stage = self.command_step(job, f"{HELPER} stage")
                for command, step in (("restore", restore), ("stage", stage)):
                    expected = (
                        f"{HELPER} {command} {arguments} "
                        f'--fingerprint "{FINGERPRINT}" --cache-dir .native-package-cache'
                    )
                    if command == "restore":
                        expected += ' --github-output "$GITHUB_OUTPUT"'
                    self.assertEqual(step["run"].strip(), expected)
                    self.assertEqual(step["shell"], "bash")
                cache = self.one_step(job, id="native-cache")
                self.assertLess(steps.index(fingerprint), steps.index(cache))
                self.assertLess(steps.index(cache), steps.index(restore))

    def test_both_crates_build_unless_verified_binaries_were_reused(self):
        for job in BUILD_JOBS:
            with self.subTest(job=job):
                steps = self.jobs[job]["steps"]
                restore = self.one_step(job, id="native-restore")
                rust_cache = self.one_step(job, uses="Swatinem/rust-cache@v2")
                self.assertLess(steps.index(restore), steps.index(rust_cache))
                for crate in ("raw-ffi", "raw-napi"):
                    build = self.command_step(job, f"-p {crate} ")
                    for outcome, reused in itertools.product(
                        ("success", "failure", "skipped", "cancelled"),
                        ("true", "false", ""),
                    ):
                        context = {
                            "steps.native-restore.outcome": outcome,
                            "steps.native-restore.outputs.reused": reused,
                        }
                        for step in (rust_cache, build):
                            self.assertEqual(
                                enabled(step["if"], context),
                                outcome != "success" or reused != "true",
                                context,
                            )
                            self.assertFalse(
                                enabled(step["if"], context, success=False)
                            )
                    self.assertLess(steps.index(restore), steps.index(build))
                    self.assertLess(steps.index(rust_cache), steps.index(build))
                    self.assertNotIn("continue-on-error", build)

    def test_save_requires_successful_main_dispatch_builds(self):
        for job in BUILD_JOBS:
            with self.subTest(job=job):
                steps = self.jobs[job]["steps"]
                stage = self.command_step(job, f"{HELPER} stage")
                save = self.one_step(job, uses="actions/cache/save@v4")
                self.assertEqual(stage["id"], "native-stage")
                for event, ref, fingerprint, key, staged, success in itertools.product(
                    ("workflow_dispatch", "pull_request", "push", "workflow_call"),
                    ("refs/heads/main", "refs/heads/feature", "refs/tags/v0.1.6"),
                    ("success", "failure", "skipped"),
                    ("exact-key", ""),
                    ("success", "failure", "skipped"),
                    (True, False),
                ):
                    context = {
                        "github.event_name": event,
                        "github.ref": ref,
                        "steps.native-fingerprint.outcome": fingerprint,
                        "steps.native-fingerprint.outputs.key": key,
                        "steps.native-stage.outcome": staged,
                    }
                    can_stage = (
                        event == "workflow_dispatch"
                        and ref == "refs/heads/main"
                        and fingerprint == "success"
                        and bool(key)
                        and success
                    )
                    self.assertEqual(
                        enabled(stage["if"], context, success), can_stage, context
                    )
                    self.assertEqual(
                        enabled(save["if"], context, success),
                        can_stage and staged == "success",
                        context,
                    )
                for step in (stage, save):
                    self.assertIs(step["continue-on-error"], True)
                restore = self.one_step(job, id="native-cache")
                self.assertEqual(save["with"], restore["with"])
                for crate in ("raw-ffi", "raw-napi"):
                    build = self.command_step(job, f"-p {crate} ")
                    self.assertLess(steps.index(build), steps.index(stage))
                self.assertLess(steps.index(stage), steps.index(save))

    def test_audit_and_all_artifacts_run_even_when_binaries_are_reused(self):
        linux = self.jobs["build-linux"]["steps"]
        audit = self.command_step("build-linux", "./src/maple/scripts/audit-linkage.sh")
        self.assertNotIn("if", audit)
        self.assertNotIn("continue-on-error", audit)
        self.assertIn(
            '"src/raw-pipeline/target/${{ matrix.target }}/release/libraw_ffi.so" '
            '"${{ matrix.libc_type }}"',
            audit["run"],
        )
        self.assertLess(
            linux.index(self.command_step("build-linux", "-p raw-ffi ")),
            linux.index(audit),
        )
        self.assertLess(
            linux.index(audit),
            linux.index(self.command_step("build-linux", f"{HELPER} stage")),
        )
        for job, library in zip(
            BUILD_JOBS, ("libraw_ffi.so", "libraw_ffi.dylib", "raw_ffi.dll")
        ):
            with self.subTest(job=job):
                uploads = [
                    step
                    for step in self.jobs[job]["steps"]
                    if step.get("uses") == "actions/upload-artifact@v4"
                ]
                self.assertEqual(len(uploads), 2)
                package, target, platform = (
                    ("maple-win32-x64-msvc", "x86_64-pc-windows-msvc", "win32-x64-msvc")
                    if job == "build-windows"
                    else (
                        "${{ matrix.pkg_name }}",
                        "${{ matrix.target }}",
                        "${{ matrix.platform_dir }}",
                    )
                )
                for upload, suffix, filename in zip(
                    uploads, ("", "-napi"), (library, f"raw-napi.{platform}.node")
                ):
                    self.assertNotIn("if", upload)
                    self.assertEqual(
                        upload["with"],
                        {
                            "name": package + suffix,
                            "path": f"src/raw-pipeline/target/{target}/release/{filename}",
                            "if-no-files-found": "error",
                        },
                    )

    def test_publish_bun_and_node_acceptance_remain_required(self):
        self.assertEqual(set(self.jobs["publish"]["needs"]), set(BUILD_JOBS))
        self.assertNotIn("if", self.jobs["publish"])
        self.assertEqual(self.jobs["node-22-acceptance"]["needs"], ["publish"])
        self.assertEqual(
            self.jobs["node-22-acceptance"]["if"],
            "always() && needs.publish.result == 'success'",
        )
        gate = self.jobs["validation-result"]
        self.assertEqual(
            set(gate["needs"]), {*BUILD_JOBS, "publish", "node-22-acceptance"}
        )
        self.assertNotIn("if", gate)
        for job in ("publish", "node-22-acceptance"):
            for step in self.jobs[job]["steps"]:
                self.assertNotIn("if", step)
                self.assertNotIn("continue-on-error", step)
            download = self.one_step(job, uses="actions/download-artifact@v4")
            self.assertEqual(download["with"], {"path": "artifacts"})
            self.command_step(
                job, "bun src/maple/scripts/assemble-packages.ts artifacts"
            )
            node = self.one_step(job, uses="actions/setup-node@v4")
            self.assertEqual(node["with"]["node-version"], 22)
        bun = self.command_step("publish", "bun test")
        self.assertEqual(bun["working-directory"], "src/maple")
        self.assertEqual(
            bun["run"].splitlines(), ["bun install", "bun run build", "bun test"]
        )
        self.assertEqual(bun["env"]["MAPLE_NATIVE_LIB"], NATIVE_LIB)
        install = self.command_step("node-22-acceptance", "npm install --omit=optional")
        self.assertIn("npm run build", install["run"])
        smoke = self.command_step(
            "node-22-acceptance", "node scripts/node-smoke-test.mjs"
        )
        self.assertEqual(smoke["run"].strip(), "node scripts/node-smoke-test.mjs")
        self.assertEqual(smoke["working-directory"], "src/maple")
        self.assertEqual(smoke["env"]["MAPLE_NATIVE_LIB"], NATIVE_LIB)
        publish = self.command_step("publish", 'npm publish "./$dir"')
        self.assertIn('npm pack "./$dir" --dry-run', publish["run"])
        self.assertIn(
            'if [ "$EVENT_NAME" != "push" ] || [ "$REF_TYPE" != "tag" ] || '
            '[ "$DRY_RUN_INPUT" = "true" ]; then',
            publish["run"],
        )

    def test_native_helper_and_regression_test_changes_trigger_validation(self):
        # PyYAML treats the unquoted Actions `on` key as YAML 1.1 True.
        paths = self.config[True]["pull_request"]["paths"]
        for path in (
            "tools/native_package_cache.py",
            "tools/test_ci_native_cache.py",
            "tools/test_ci_native_workflow.py",
            ".github/workflows/publish-package.yml",
            "src/raw-pipeline/raw-ffi/src/lib.rs",
            "src/maple/src/index.ts",
            "src/apple/MapleUITests/Goldens/.calibration/a.png",
        ):
            with self.subTest(path=path):
                self.assertTrue(
                    any(fnmatch.fnmatchcase(path, pattern) for pattern in paths)
                )


if __name__ == "__main__":
    unittest.main()
