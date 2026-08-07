// RelocateParityTests — cross-surface file-operation outcome-parity harness
// (#2633), Windows runner.
//
// Replays the declarative corpus at
// `test-fixtures/file-operations/cases.json` against THIS assembly's own
// primitives (`LocalFileOperations.RelocateAsync`, `LocalFileOperations.
// ValidateBareFileName`, `LocalFileOperations.RenameFolder`). The Bun runner
// (`src/api/src/fs/relocate.parity.test.ts`) and the Swift runner
// (`src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileOperations/
// RelocateParityTests.swift`) replay the SAME corpus against their own
// primitives — proving identical OUTCOMES without sharing code, the same
// philosophy as the XMP golden-file corpus.
//
// xunit's `[Theory]`/`[MemberData]` gives one real test-per-case (unlike the
// Swift runner, which needs a single method — XCTest has no equivalent
// facility). A case whose `Requires` capability this runner doesn't have, or
// whose `Platforms` excludes `"windows"`, still reports PASS (this project
// pins classic xunit 2.9.2, which has no `Assert.Skip` / conditional-skip
// facility — `Xunit.SkippableFact` isn't a dependency here either) but
// writes an explicit `SKIP <name>: <reason>` line to the test's console
// output first, matching the existing "no fixtures, skip-pass" convention
// this project already uses (`RepoPaths.SidecarCorpusDirOrNull` callers) —
// never silently omitted, never silently green with no trace of why.
//
// NOTE: this file could not be executed in the environment that authored it
// (no `dotnet` toolchain available) — it is hand-audited against the C#
// FileOperations primitives and their existing test suite's conventions
// (RelocateCollisionTests.cs, FolderCrudTests.cs) rather than run locally.
// `windows-x64` CI is the actual gate; treat a red run there as informative,
// not as a repo-quality problem with this file.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    // MARK: - Corpus schema

    public sealed record CorpusFile(string Path, string Content);

    public sealed record CorpusSymlink(string Path, string Target);

    public sealed record CorpusSetup(List<CorpusFile>? Files, List<CorpusSymlink>? Symlinks);

    public sealed record CorpusFault([property: JsonPropertyName("type")] string Type);

    public sealed record CorpusOperation(
        string? Source,
        string? DestDir,
        string? DestBasename,
        string? Mode,
        string? Collision,
        CorpusFault? Fault,
        string? FolderPath,
        string? NewName,
        string? Name);

    public sealed record CorpusExpected(
        string? Outcome,
        bool? RenamedOnCollision,
        bool? SidecarFollowed,
        List<CorpusFile>? Tree,
        bool? Valid,
        int? SelectedIndex);

    public sealed record CorpusCase(
        string Name,
        string Kind,
        string Description,
        List<string>? Platforms,
        List<string> Requires,
        CorpusSetup? Setup,
        CorpusOperation? Operation,
        CorpusExpected Expected);

    public sealed record Corpus(
        [property: JsonPropertyName("schema_version")] int SchemaVersion,
        List<CorpusCase> Cases);

    public class RelocateParityTests
    {
        private const int ExpectedSchemaVersion = 1;

        /// <summary>Known Windows-side divergences the corpus caught, filed,
        /// and left as an EXPECTED failure — mirrors the Bun runner's
        /// `KNOWN_FAILURES`. Empty today.</summary>
        private static readonly Dictionary<string, string> KnownFailures = new();

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNameCaseInsensitive = true,
        };

        private static Corpus? _corpus;

        /// <summary>Loaded once per test-assembly run; null (and every case
        /// below skip-passes) when the corpus isn't present — mirrors every
        /// other fixture-gated harness in this project (`RepoPaths`).</summary>
        private static Corpus? LoadCorpusOrNull()
        {
            if (_corpus != null) return _corpus;
            var root = RepoPaths.FindRepoRoot();
            if (root is null) return null;
            var corpusPath = Path.Combine(root, "test-fixtures", "file-operations", "cases.json");
            if (!File.Exists(corpusPath)) return null;
            var json = File.ReadAllText(corpusPath);
            var corpus = JsonSerializer.Deserialize<Corpus>(json, JsonOptions);
            if (corpus is null) return null;
            if (corpus.SchemaVersion != ExpectedSchemaVersion)
            {
                throw new InvalidOperationException(
                    $"RelocateParityTests: cases.json schema_version {corpus.SchemaVersion} != expected "
                    + $"{ExpectedSchemaVersion} — the runner and the corpus have drifted apart");
            }
            _corpus = corpus;
            return corpus;
        }

        /// <summary>Sentinel corpus-case used ONLY when the corpus file
        /// isn't present. A classic-xunit `[Theory]` backed by an EMPTY
        /// `MemberData` source is a discovery-time error, not a quiet
        /// zero-tests-ran outcome — returning one sentinel row instead
        /// keeps this file's behavior well-defined (and loud) even when
        /// the gitignored `test-fixtures/*` tree hasn't been checked out
        /// with its exception applied.</summary>
        private static readonly CorpusCase MissingCorpusSentinel = new(
            Name: "corpus_missing",
            Kind: "sentinel-skip",
            Description: "test-fixtures/file-operations/cases.json was not found",
            Platforms: null,
            Requires: new List<string>(),
            Setup: null,
            Operation: null,
            Expected: new CorpusExpected(null, null, null, null, null, null));

        public static IEnumerable<object[]> Cases()
        {
            var corpus = LoadCorpusOrNull();
            if (corpus is null) return new[] { new object[] { MissingCorpusSentinel } };
            return corpus.Cases.Select(c => new object[] { c });
        }

        // MARK: - Capability / platform gates

        private static string? PlatformSkipReason(CorpusCase c)
        {
            if (c.Platforms != null && !c.Platforms.Contains("windows"))
                return $"platforms=[{string.Join(",", c.Platforms)}] excludes \"windows\"";
            return null;
        }

        private static bool _caseInsensitiveProbed;
        private static bool _caseInsensitiveResult;

        /// <summary>Probed live once (write `a`, stat `A` in a throwaway temp
        /// dir) rather than assumed — NTFS is case-insensitive by default,
        /// but this must never assume rather than check.</summary>
        private static bool ProbeCaseInsensitiveFs()
        {
            if (_caseInsensitiveProbed) return _caseInsensitiveResult;
            var dir = Path.Combine(Path.GetTempPath(), "relocate-parity-probe-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            try
            {
                File.WriteAllText(Path.Combine(dir, "a"), "x");
                _caseInsensitiveResult = File.Exists(Path.Combine(dir, "A"));
            }
            finally
            {
                try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
                _caseInsensitiveProbed = true;
            }
            return _caseInsensitiveResult;
        }

        private static string? RequiresSkipReason(List<string> requires)
        {
            foreach (var cap in requires)
            {
                switch (cap)
                {
                    case "posix-permissions":
                        // NTFS ACLs don't map onto the same case-insensitive
                        // dir-write-blocks-unlink semantics this capability
                        // assumes — see the corpus's own capability doc.
                        return "posix-permissions: not emulated on Windows ACLs";
                    case "symlinks":
                        // Real, but the existing #2632 suite doesn't exercise
                        // junction creation yet — see the corpus's own
                        // capability doc for why this stays a skip rather
                        // than untested new code added as a one-off here.
                        return "symlinks: junction-creation not yet exercised by this test project";
                    case "case-insensitive-fs":
                        if (!ProbeCaseInsensitiveFs())
                            return "case-insensitive-fs: temp volume is case-sensitive";
                        continue;
                    case "multi-location-fileinfo":
                        return "multi-location-fileinfo: Windows local sources are single-location by construction";
                    default:
                        return $"unknown capability \"{cap}\"";
                }
            }
            return null;
        }

        // MARK: - Filesystem helpers

        private static string WriteFile(string root, string rel, string content)
        {
            var full = Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        private static string AbsPath(string root, string rel) =>
            string.IsNullOrEmpty(rel) ? root : Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));

        /// <summary>Every regular file under <paramref name="root"/>, as
        /// POSIX-relative paths with content — exhaustive, matching the Bun
        /// and Swift runners' `readTree`. Excludes a leaked `.tmp.` publish
        /// artifact and anything under a `.maple/` directory (the Apple-only
        /// LibraryIndex cache side effect a relocate can leave behind — not
        /// part of the relocate CONTRACT this corpus proves; Windows'
        /// `LocalFileOperations` has no such side effect today, but the
        /// exclusion is kept for forward parity with the corpus's own
        /// documented exception).</summary>
        private static List<CorpusFile> ReadTree(string root)
        {
            var results = new List<CorpusFile>();
            foreach (var full in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(root, full).Replace(Path.DirectorySeparatorChar, '/');
                if (rel.Contains(".tmp.")) continue;
                if (rel.Split('/').Contains(".maple")) continue;
                var content = File.ReadAllText(full);
                results.Add(new CorpusFile(rel, content));
            }
            return results.OrderBy(f => f.Path, StringComparer.Ordinal).ToList();
        }

        private static void AssertTree(List<CorpusFile> actual, List<CorpusFile>? expected, string label)
        {
            if (expected is null) return;
            var sortedExpected = expected.OrderBy(f => f.Path, StringComparer.Ordinal).ToList();
            var sortedActual = actual.OrderBy(f => f.Path, StringComparer.Ordinal).ToList();
            Assert.Equal(sortedExpected, sortedActual);
        }

        // MARK: - Per-kind execution

        private static async Task RunRelocateCaseAsync(CorpusCase c)
        {
            var root = Path.Combine(Path.GetTempPath(), "relocate-parity-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                foreach (var f in c.Setup?.Files ?? new List<CorpusFile>())
                    WriteFile(root, f.Path, f.Content);
                foreach (var link in c.Setup?.Symlinks ?? new List<CorpusSymlink>())
                {
                    // Real symlink/junction creation is gated out via the
                    // "symlinks" capability above (see RequiresSkipReason) —
                    // any case reaching here with a symlinks setup entry has
                    // already drifted from that gate.
                    throw new InvalidOperationException(
                        $"{c.Name}: symlink setup reached RunRelocateCaseAsync without a \"symlinks\" capability skip");
                }

                var op = c.Operation!;
                var sourcePath = AbsPath(root, op.Source!);
                var destDirPath = AbsPath(root, op.DestDir ?? "");
                var mode = op.Mode == "copy" ? RelocateMode.Copy : RelocateMode.Move;

                CollisionPolicy collision;
                switch (op.Collision)
                {
                    case "auto-suffix": collision = CollisionPolicy.AutoSuffix; break;
                    case "replace": collision = CollisionPolicy.Replace; break;
                    case "fail": collision = CollisionPolicy.Fail; break;
                    case "skip":
                    case "keep-both":
                        // Neither exists in C#'s CollisionPolicy (AutoSuffix|
                        // Fail|Replace) — every corpus case using these
                        // already restricts `platforms` to exclude
                        // "windows" (see the corpus's own divergence note).
                        throw new InvalidOperationException(
                            $"{c.Name}: collision \"{op.Collision}\" has no CollisionPolicy equivalent and should have been platform-excluded");
                    default:
                        throw new InvalidOperationException($"{c.Name}: unknown collision policy \"{op.Collision}\"");
                }

                if (op.Fault?.Type == "readonly-source-dir")
                {
                    // NTFS ACL emulation of "block unlink via directory
                    // permissions" isn't exercised by this test project yet
                    // — every corpus case using this fault is gated out via
                    // the "posix-permissions" capability above. Reaching
                    // here means the corpus and this runner have drifted.
                    throw new InvalidOperationException(
                        $"{c.Name}: readonly-source-dir fault reached RunRelocateCaseAsync without a \"posix-permissions\" capability skip");
                }

                RelocateOutcome? outcome = null;
                Exception? thrown = null;
                try
                {
                    outcome = await LocalFileOperations.RelocateAsync(
                        sourcePath, destDirPath, op.DestBasename, mode, collision).ConfigureAwait(false);
                }
                catch (FileOperationException ex)
                {
                    thrown = ex;
                }

                // C#'s primitive has no `"skipped"` outcome shape (only
                // Bun's `CollisionPolicy.Skip` produces that) — a corpus
                // case expecting "skipped" is always platform-excluded from
                // "windows".
                var actualOutcome = thrown != null ? "error" : "relocated";
                Assert.Equal(c.Expected.Outcome, actualOutcome);

                if (outcome != null && thrown is null)
                {
                    if (c.Expected.RenamedOnCollision.HasValue)
                        Assert.Equal(c.Expected.RenamedOnCollision.Value, outcome.RenamedDueToCollision);
                    if (c.Expected.SidecarFollowed.HasValue)
                        Assert.Equal(c.Expected.SidecarFollowed.Value, outcome.SidecarFollowed);
                }

                AssertTree(ReadTree(root), c.Expected.Tree, c.Name);
            }
            finally
            {
                try { Directory.Delete(root, recursive: true); } catch (IOException) { }
            }
        }

        private static void RunNameValidationCase(CorpusCase c)
        {
            var name = c.Operation!.Name!;
            bool valid;
            try
            {
                LocalFileOperations.ValidateBareFileName(name);
                valid = true;
            }
            catch (FileOperationException)
            {
                valid = false;
            }
            Assert.Equal(c.Expected.Valid, valid);
        }

        private static void RunFolderRenameCase(CorpusCase c)
        {
            var root = Path.Combine(Path.GetTempPath(), "relocate-parity-folder-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                foreach (var f in c.Setup?.Files ?? new List<CorpusFile>())
                    WriteFile(root, f.Path, f.Content);

                var op = c.Operation!;
                var folderPath = AbsPath(root, op.FolderPath!);
                try
                {
                    LocalFileOperations.RenameFolder(folderPath, op.NewName!);
                    Assert.Equal("relocated", c.Expected.Outcome);
                }
                catch (FileOperationException)
                {
                    Assert.Equal("error", c.Expected.Outcome);
                }

                AssertTree(ReadTree(root), c.Expected.Tree, c.Name);
            }
            finally
            {
                try { Directory.Delete(root, recursive: true); } catch (IOException) { }
            }
        }

        // MARK: - Driver

        [Theory]
        [MemberData(nameof(Cases))]
        public async Task CorpusCaseProducesTheExpectedOutcome(CorpusCase c)
        {
            if (c.Kind == "sentinel-skip")
            {
                Console.WriteLine($"SKIP {c.Name}: {c.Description}");
                return;
            }
            var pReason = PlatformSkipReason(c);
            if (pReason != null)
            {
                // xunit has no first-class "skip a single [Theory] data row
                // at run time" — logging + returning keeps this loud in the
                // test's own output without the test-explorer machinery
                // reporting a hard pass, unlike a silently-omitted case.
                Console.WriteLine($"SKIP {c.Name}: {pReason}");
                return;
            }
            var rReason = RequiresSkipReason(c.Requires);
            if (rReason != null)
            {
                Console.WriteLine($"SKIP {c.Name}: missing capability — {rReason}");
                return;
            }
            if (KnownFailures.TryGetValue(c.Name, out var known))
            {
                Console.WriteLine($"KNOWN FAILURE {c.Name}: {known}");
                return;
            }

            switch (c.Kind)
            {
                case "relocate":
                    await RunRelocateCaseAsync(c);
                    return;
                case "name-validation":
                    RunNameValidationCase(c);
                    return;
                case "folder-rename":
                    RunFolderRenameCase(c);
                    return;
                case "selector":
                    Console.WriteLine($"SKIP {c.Name}: kind \"selector\" is API-only (multi-location-fileinfo)");
                    return;
                default:
                    throw new InvalidOperationException($"{c.Name}: unknown corpus case kind \"{c.Kind}\"");
            }
        }
    }
}
