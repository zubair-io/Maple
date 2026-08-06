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
                var secondResave = XmpWriter.Serialize(secondParse!);

                Assert.True(firstResave == secondResave,
                    $"{file}: a second parse → serialize produced different bytes than the first " +
                    "— write → parse → write is not a fixed point for this fixture");
            }
        }
    }
}
