// SidecarCorpusRoundTripTests — round-trips every `.xmp` file in the
// shared golden corpus (`test-fixtures/sidecars/`, described in
// `docs/spec/06-cross-platform.md` § "Sidecar parity: the hard test":
// Golden Maple sidecars, Lightroom sidecars with masks/history/snapshots,
// and synthetic edge cases). This is the harness Milestone 23's
// file-operation parity work depends on (#2635).
//
// `test-fixtures/*` is gitignored (.gitignore: "Test fixtures — local-only
// ... See docs/spec/11-testing.md ... for how to regenerate or fetch these
// locally") and `sidecars/` carries no exception for it the way
// `budgets.json` does, so a fresh clone — and, as far as this PR's author
// could determine, the hosted windows-latest CI runner too — has no corpus
// on disk. That's the expected common case, not a failure: this test
// skip-passes with a message when the directory is absent or empty,
// mirroring `src/scripts/test_color_pipeline.sh`'s "manifest not found —
// skipping" convention (see CLAUDE.md § "Objective color testing").
//
// What's asserted per file is a fixed point of MEANING (parse → serialize
// → re-parse → the two parsed models agree), not a byte-identical re-emit.
// A byte-identical claim is what Swift/TS assert for each other (docs/
// xmp-canonical-format.md § "Test contract" item 4) because their models
// cover the full schema; `AdjustmentState` is a structural subset (no
// crop, no keywords, no metadata block, no white-balance preset — see
// `WindowsFixtureModel`'s header comment), so a real Maple-authored fixture
// carrying any of those would, correctly, come back through Windows with
// different bytes in that region even though nothing was lost (passthrough
// preserves it) — the model-equality check catches a real Windows-caused
// regression without also flagging Windows's known, not-yet-built field
// coverage as if it were a bug.
//
// Passthrough content — masks, history, snapshots, metadata blocks, any
// field Windows doesn't model — is exactly what this corpus exists to
// protect (docs/spec/06-cross-platform.md § "Sidecar parity: the hard
// test"), so it is asserted too, with two different equality rules per
// docs/spec/01-data-model.md § "Passthrough buckets": attribute/namespace
// passthrough is canonicalized (sorted) on write, so an input document's
// arbitrary attribute order legitimately differs from Windows's own sorted
// re-emit — compared order-insensitively. Node passthrough order is
// load-bearing ("Passthrough nodes preserve order... mask groups, history
// entries, and snapshots rely on element order") — compared as an exact
// ordered sequence.

using System.Collections.Generic;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests
{
    public class SidecarCorpusRoundTripTests
    {
        private readonly ITestOutputHelper _output;

        public SidecarCorpusRoundTripTests(ITestOutputHelper output)
        {
            _output = output;
        }

        [Fact]
        public void EveryCorpusFixtureRoundTripsToTheSameParsedModel()
        {
            var corpusDir = RepoPaths.SidecarCorpusDirOrNull();
            if (corpusDir is null)
            {
                _output.WriteLine(
                    "SidecarCorpusRoundTripTests: test-fixtures/sidecars/ not found or " +
                    "empty (gitignored local-only fixture corpus) — skipping.");
                return;
            }

            var files = Directory.EnumerateFiles(corpusDir, "*.xmp", SearchOption.AllDirectories)
                .OrderBy(f => f)
                .ToList();
            Assert.NotEmpty(files);

            foreach (var file in files)
            {
                var xml = File.ReadAllText(file);
                var firstParse = XmpParser.Parse(xml);
                Assert.True(firstParse is not null, $"{file}: failed to parse as a well-formed sidecar");

                var resaved = XmpWriter.Serialize(firstParse!);
                var secondParse = XmpParser.Parse(resaved);
                Assert.True(secondParse is not null, $"{file}: re-parse of the resaved document failed");

                AdjustmentStateAssert.Equal(firstParse!.Adjustments, secondParse!.Adjustments);
                Assert.True(firstParse.Rating == secondParse.Rating, $"{file}: xmp:Rating changed on resave");
                Assert.True(firstParse.Flag == secondParse.Flag, $"{file}: papp:Flag changed on resave");
                Assert.True(firstParse.ColorLabel == secondParse.ColorLabel,
                    $"{file}: papp:ColorLabel changed on resave");

                AssertAttributesMatchIgnoringOrder(
                    file, firstParse.PassthroughAttributes, secondParse.PassthroughAttributes);
                AssertNamespacesMatchIgnoringOrder(
                    file, firstParse.PassthroughNamespaces, secondParse.PassthroughNamespaces);
                AssertNodesMatchInOrder(
                    file, nameof(XmpSidecarDocument.PassthroughNodes),
                    firstParse.PassthroughNodes, secondParse.PassthroughNodes);
                AssertNodesMatchInOrder(
                    file, nameof(XmpSidecarDocument.PassthroughRdfNodes),
                    firstParse.PassthroughRdfNodes, secondParse.PassthroughRdfNodes);
                AssertNodesMatchInOrder(
                    file, nameof(XmpSidecarDocument.PassthroughXmpmetaNodes),
                    firstParse.PassthroughXmpmetaNodes, secondParse.PassthroughXmpmetaNodes);
            }
        }

        [Fact]
        public void ResavingACorpusFixtureIsItselfAFixedPoint()
        {
            var corpusDir = RepoPaths.SidecarCorpusDirOrNull();
            if (corpusDir is null)
            {
                _output.WriteLine(
                    "SidecarCorpusRoundTripTests: test-fixtures/sidecars/ not found or " +
                    "empty (gitignored local-only fixture corpus) — skipping.");
                return;
            }

            var files = Directory.EnumerateFiles(corpusDir, "*.xmp", SearchOption.AllDirectories)
                .OrderBy(f => f)
                .ToList();
            Assert.NotEmpty(files);

            foreach (var file in files)
            {
                var firstParse = XmpParser.Parse(File.ReadAllText(file));
                Assert.True(firstParse is not null, $"{file}: failed to parse as a well-formed sidecar");

                var firstResave = XmpWriter.Serialize(firstParse!);
                var secondParse = XmpParser.Parse(firstResave);
                Assert.True(secondParse is not null,
                    $"{file}: re-parse of the first resave failed — a document Windows itself just " +
                    "wrote is no longer parseable by its own parser");

                var secondResave = XmpWriter.Serialize(secondParse!);

                Assert.True(firstResave == secondResave,
                    $"{file}: a second parse → serialize produced different bytes than the first " +
                    "— write → parse → write is not a fixed point for this fixture");
            }
        }

        // ── Passthrough equality helpers ────────────────────────────────────

        /// <summary>Order-insensitive: attribute passthrough is re-sorted
        /// canonically on every write (docs/spec/01-data-model.md § "Passthrough
        /// fields emit alphabetically by fully-qualified name"), so the source
        /// document's arbitrary order is not itself meaningful.</summary>
        private static void AssertAttributesMatchIgnoringOrder(
            string file, IReadOnlyList<XmpAttribute> first, IReadOnlyList<XmpAttribute> second)
        {
            var a = first.OrderBy(x => x.Name, System.StringComparer.Ordinal)
                .ThenBy(x => x.Value, System.StringComparer.Ordinal).ToList();
            var b = second.OrderBy(x => x.Name, System.StringComparer.Ordinal)
                .ThenBy(x => x.Value, System.StringComparer.Ordinal).ToList();
            Assert.True(a.SequenceEqual(b),
                $"{file}: passthrough attributes changed across a resave (compared order-insensitively)");
        }

        /// <summary>Order-insensitive for the same reason as attributes above —
        /// this is the set of extra `xmlns:` declarations passthrough attributes
        /// need, not itself ordered content.</summary>
        private static void AssertNamespacesMatchIgnoringOrder(
            string file, IReadOnlyList<XmpNamespaceDecl> first, IReadOnlyList<XmpNamespaceDecl> second)
        {
            var a = first.OrderBy(x => x.Prefix, System.StringComparer.Ordinal)
                .ThenBy(x => x.Uri, System.StringComparer.Ordinal).ToList();
            var b = second.OrderBy(x => x.Prefix, System.StringComparer.Ordinal)
                .ThenBy(x => x.Uri, System.StringComparer.Ordinal).ToList();
            Assert.True(a.SequenceEqual(b),
                $"{file}: passthrough namespace declarations changed across a resave " +
                "(compared order-insensitively)");
        }

        /// <summary>Exact, ordered: node passthrough order is load-bearing —
        /// mask groups, history entries, and snapshots rely on it
        /// (docs/xmp-canonical-format.md § "Passthrough"; docs/spec/01-data-model.md
        /// § "Passthrough nodes preserve order").</summary>
        private static void AssertNodesMatchInOrder(
            string file, string bucketName, IReadOnlyList<string> first, IReadOnlyList<string> second)
        {
            Assert.True(first.SequenceEqual(second),
                $"{file}: {bucketName} changed order or content across a resave — node order is " +
                "load-bearing and must be preserved exactly");
        }
    }
}
