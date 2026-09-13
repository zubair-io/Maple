// LensProfileChoiceLogicTests — the Windows Lens panel's profile dropdown
// (#3568, Windows slice of the bundled-Lensfun epic #3564).
//
// Mirrors MapleCoreTests/LensProfileChoiceTests.swift case-for-case: option
// ordering (Automatic first, then compatible lenses sorted by maker/model),
// the automatic-match label, a manual bundled pick, an imported LCP
// reference, and the source line per resolved source. Every input here is a
// literal record — no raw-ffi, no RAW fixture, no ViewModel — the same
// WinUI-free contract `LensProfileChoiceLogic.cs` itself keeps.

using System;
using System.Linq;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class LensProfileChoiceLogicTests
    {
        private static LensProfileResolution Matched(string lens, string dbVersion = "12f5976 (2026-09-11)") =>
            new("lensfun", "in-range", true, true, true,
                Array.Empty<string>(), Array.Empty<string>(), Array.Empty<LensProfileSample>(),
                lens, dbVersion);

        [Fact]
        public void Automatic_option_leads_then_compatible_lenses_sorted_by_maker_then_model()
        {
            var auto = Matched("Sony FE 24-70mm f/4 ZA OSS");
            var compatible = new[]
            {
                new CompatibleLens("sony/fe-70-200mm-f2.8-gm@sony-e", "Sony", "FE 70-200mm F2.8 GM"),
                new CompatibleLens("sony/fe-16-35mm-f2.8-gm@sony-e", "Sony", "FE 16-35mm F2.8 GM"),
                new CompatibleLens("canon/rf-24-70mm-f2.8@rf", "Canon", "RF 24-70mm F2.8"),
            };

            var built = LensProfileChoiceLogic.Build("", auto, auto, compatible);

            Assert.Equal(new[]
            {
                "Automatic — Sony FE 24-70mm f/4 ZA OSS",
                "Canon RF 24-70mm F2.8",
                "Sony FE 16-35mm F2.8 GM",
                "Sony FE 70-200mm F2.8 GM",
            }, built.Options.Select(o => o.Label));
        }

        [Fact]
        public void Automatic_option_says_no_match_when_nothing_resolved()
        {
            var built = LensProfileChoiceLogic.Build("", null, null, Array.Empty<CompatibleLens>());
            Assert.Equal("Automatic — no match", built.Options[0].Label);
            Assert.Equal(LensProfileChoiceLogic.AutomaticValue, built.Options[0].Value);
        }

        [Fact]
        public void Automatic_option_says_no_match_when_auto_evidence_is_not_lensfun_sourced()
        {
            // e.g. the body/lens matched no camera at all — the auto-match
            // call still succeeds (source "none"), but names no lens.
            var auto = new LensProfileResolution(
                "none", "embedded", false, false, false,
                Array.Empty<string>(), Array.Empty<string>(), Array.Empty<LensProfileSample>());
            var built = LensProfileChoiceLogic.Build("", auto, auto, Array.Empty<CompatibleLens>());
            Assert.Equal("Automatic — no match", built.Options[0].Label);
        }

        [Fact]
        public void Bundled_selection_reuses_current_evidence_name_and_is_not_duplicated()
        {
            var current = Matched("Sony FE 24-70mm f/4 ZA OSS");
            var compatible = new[]
            {
                new CompatibleLens("sony/fe-24-70mm-f4-za-oss@sony-e", "Sony", "FE 24-70mm f/4 ZA OSS"),
            };

            var built = LensProfileChoiceLogic.Build(
                "lensfun1:sony/fe-24-70mm-f4-za-oss@sony-e", null, current, compatible);

            // Automatic + the one bundled lens — the selected slug is
            // already in `compatible`, so it must not be appended again.
            Assert.Equal(2, built.Options.Count);
            Assert.Equal(
                "lensfun1:sony/fe-24-70mm-f4-za-oss@sony-e",
                built.Options[1].Value);
            Assert.Equal("Lensfun database 12f5976 (2026-09-11) · CC BY-SA 3.0", built.SourceLine);
        }

        [Fact]
        public void Bundled_selection_missing_from_compatible_list_is_appended_defensively()
        {
            // A stale sidecar naming a lens the current camera match no
            // longer lists — the dropdown must still show what is actually
            // selected instead of silently reverting to Automatic.
            var current = Matched("Sigma 24mm f/1.4 DG HSM");
            var built = LensProfileChoiceLogic.Build(
                "lensfun1:sigma/24mm-f1.4-dg-hsm@sony-e", null, current, Array.Empty<CompatibleLens>());

            Assert.Contains(built.Options, o => o.Value == "lensfun1:sigma/24mm-f1.4-dg-hsm@sony-e");
            Assert.Equal("Sigma 24mm f/1.4 DG HSM", built.Options[^1].Label);
        }

        [Fact]
        public void Imported_reference_appends_an_imported_option_and_source_line()
        {
            var digest = new string('a', 64);
            var reference = "lcp1:" + digest;
            var current = new LensProfileResolution(
                "lcp", "in-range", true, true, false,
                Array.Empty<string>(), Array.Empty<string>(), Array.Empty<LensProfileSample>());

            var built = LensProfileChoiceLogic.Build(reference, null, current, Array.Empty<CompatibleLens>());

            Assert.Contains(built.Options, o => o.Value == reference && o.Label == "Imported profile");
            Assert.Equal("Imported profile", built.SourceLine);
        }

        [Theory]
        [InlineData("embedded", "Embedded corrections")]
        [InlineData("none", "No lens correction data")]
        public void Source_line_per_resolved_source(string source, string expected)
        {
            var current = new LensProfileResolution(
                source, "embedded", false, false, false,
                Array.Empty<string>(), Array.Empty<string>(), Array.Empty<LensProfileSample>());
            var built = LensProfileChoiceLogic.Build("", null, current, Array.Empty<CompatibleLens>());
            Assert.Equal(expected, built.SourceLine);
        }

        [Fact]
        public void Source_line_is_no_correction_data_when_nothing_has_resolved_yet()
        {
            var built = LensProfileChoiceLogic.Build("", null, null, Array.Empty<CompatibleLens>());
            Assert.Equal("No lens correction data", built.SourceLine);
        }

        [Fact]
        public void Is_available_when_current_selection_covers_a_family()
        {
            var current = new LensProfileResolution(
                "embedded", "embedded", true, false, false,
                Array.Empty<string>(), Array.Empty<string>(), Array.Empty<LensProfileSample>());
            Assert.True(LensProfileChoiceLogic.IsAvailable(current, new[] { new LensProfileOption("", "Automatic") }));
        }

        [Fact]
        public void Is_available_when_the_dropdown_offers_a_pickable_lens_beyond_automatic()
        {
            var options = new[]
            {
                new LensProfileOption("", "Automatic — no match"),
                new LensProfileOption("lensfun1:sony/fe-24-70mm-f4-za-oss@sony-e", "Sony FE 24-70mm f/4 ZA OSS"),
            };
            Assert.True(LensProfileChoiceLogic.IsAvailable(null, options));
        }

        [Fact]
        public void Is_not_available_with_no_coverage_and_no_pickable_lens()
        {
            Assert.False(LensProfileChoiceLogic.IsAvailable(null, new[] { new LensProfileOption("", "Automatic") }));
        }
    }
}
