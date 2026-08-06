// XmpWbScaleVersionTests — characterizes a real cross-platform divergence
// found while writing this suite. Filed as a follow-up: #2670.
//
// `docs/xmp-canonical-format.md` § "WB slider-scale versioning" describes
// `papp:WbScaleVersion` stamps 1/2/3 with an absent-stamp heuristic
// resolving to 1 or 3 (the doc is itself stale here — see the PR
// description; the actual Swift/TypeScript implementations recognize
// stamps 1–5 and normalize the in-memory model to 1 or 5). What both
// reference implementations do, precisely:
//
//   - Swift: `XMPSerialization.swift` lines ~58-85 — an explicit stamp of
//     2, 3, or 4 triggers `WbDngTemperature.authoredPairToV5`, a full
//     Hernández-Andrés/CIE-1960-UCS/Robertson-isotherm re-projection of the
//     authored (temperature, tint) pair, and the in-memory model is then
//     stamped version 5 — never 2, 3, or 4.
//   - TypeScript: `xmp-wb-scale.ts` `resolveWbScaleVersion` +
//     `normalizeParsedWb` — same conversion (`authoredPairToV5`), same
//     `modelVersion` clamp to {1, 5}.
//
// `XmpParser.cs`'s heuristic (`XmpParser.ParseAttributes`, the
// `papp:WbScaleVersion` case plus the `doc.WbScaleVersion = wbStamp ?? …`
// line) does neither: it stores whatever integer the stamp attribute
// carries verbatim, with no clamp to {1, 5}, and never calls any
// conversion function — `crs:Temperature`/`crs:Tint` go through the same
// generic `NumericByKey` parse path as every other slider, a direct
// `double.TryParse` with no post-processing.
//
// The practical effect: for the SAME sidecar carrying a real (historically
// producible, per the version's own history in the canonical-format doc)
// `papp:WbScaleVersion="2"` stamp, Windows and Apple/Web resolve DIFFERENT
// in-memory (temperature, tint) values and a different stored version —
// not merely a formatting difference, a white-balance rendering
// difference. This suite can only exercise the Windows side (there's no
// single process that runs Swift/TypeScript/C# together — the same
// limitation `XMPCanonicalFormatTests.swift`'s header describes for the
// golden-literal duplication), so what's asserted below is Windows's own
// behavior, traced against the Swift/TypeScript source read alongside it.

using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpWbScaleVersionTests
    {
        private static string DocumentWithStamp(string stamp) => string.Join("\n", new[]
        {
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
            "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
            "    <rdf:Description rdf:about=\"\"",
            "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
            "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
            "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
            "      crs:Temperature=\"5900\"",
            "      crs:Tint=\"20\"",
            $"      papp:WbScaleVersion=\"{stamp}\"",
            "      crs:HasSettings=\"True\">",
            "    </rdf:Description>",
            "  </rdf:RDF>",
            "</x:xmpmeta>",
            "<?xpacket end=\"w\"?>",
        });

        [Theory]
        [InlineData("2")]
        [InlineData("3")]
        [InlineData("4")]
        public void KnownGap_LegacyStampIsStoredVerbatimNotClampedToOneOrFive(string stamp)
        {
            var doc = XmpParser.Parse(DocumentWithStamp(stamp));
            Assert.NotNull(doc);

            // Swift/TS would store 5 here (modelVersion is always 1 or 5).
            Assert.Equal(int.Parse(stamp), doc!.WbScaleVersion);
        }

        [Theory]
        [InlineData("2")]
        [InlineData("3")]
        [InlineData("4")]
        public void KnownGap_TemperatureAndTintAreNeverRescaledForLegacyStamps(string stamp)
        {
            var doc = XmpParser.Parse(DocumentWithStamp(stamp));
            Assert.NotNull(doc);

            // Swift/TS would run (5900, 20) through `authoredPairToV5` for
            // this stamp and store a DIFFERENT physical-chromaticity-
            // equivalent pair. Windows stores the raw XML numbers,
            // unconverted — proving no rescale happens anywhere in the
            // parse path.
            Assert.Equal(5900, doc!.Adjustments.Temperature, precision: 9);
            Assert.Equal(20, doc.Adjustments.Tint, precision: 9);
        }

        [Fact]
        public void KnownGap_ResaveOfALegacyStampedDocumentKeepsTheUnnormalizedStamp()
        {
            var doc = XmpParser.Parse(DocumentWithStamp("2"));
            Assert.NotNull(doc);

            var resaved = XmpWriter.Serialize(doc!);

            // Internally consistent (a fixed point from Windows's own
            // point of view) but not what a platform implementing the
            // documented normalization would produce on the same input —
            // Swift/TS would write "5" here, never "2".
            Assert.Contains("papp:WbScaleVersion=\"2\"", resaved);
        }

        [Fact]
        public void StampOneRoundTripsUnconvertedOnEveryPlatform()
        {
            // Version 1 is the one case where Windows's "store it verbatim"
            // behavior actually agrees with Swift/TS: an explicit V1 stamp
            // deliberately does NOT load-normalize anywhere (raw-core
            // converts it at develop time, using the image's calibration
            // frame, which the sidecar layer doesn't have). This is the
            // control case showing the divergence above is specific to
            // 2/3/4, not a general "Windows ignores the stamp" problem.
            var doc = XmpParser.Parse(DocumentWithStamp("1"));
            Assert.NotNull(doc);

            Assert.Equal(1, doc!.WbScaleVersion);
            Assert.Equal(5900, doc.Adjustments.Temperature, precision: 9);
            Assert.Equal(20, doc.Adjustments.Tint, precision: 9);
        }
    }
}
