// XmpLensProfileTests — `papp:LensProfile` (#2435 / #3480), the free-form
// imported-LCP reference: parsed verbatim, written only when non-empty,
// escaped like every other string attribute, and never left in the
// passthrough bucket. Mirrors `LensProfileXMPTests.swift` and
// `lens-correction.spec.ts`'s `papp:LensProfile` block, plus a real-file
// round trip through SidecarStore (CLAUDE.md: no mocks for the sidecar
// layer) and a byte-identical re-save of a sidecar as the Web writer emits it.

using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpLensProfileTests
    {
        private static readonly string Digest = new('a', 64);

        [Theory]
        [InlineData("lcp1:")]
        [InlineData("lcp1-ack:")]
        public void ReferenceRoundTripsThroughWriterAndParser(string prefix)
        {
            var reference = prefix + Digest;
            var doc = new XmpSidecarDocument();
            doc.Adjustments.LensProfile = reference;

            var xml = XmpWriter.Serialize(doc);
            Assert.Contains($"papp:LensProfile=\"{reference}\"", xml);

            var parsed = XmpParser.Parse(xml);
            Assert.NotNull(parsed);
            Assert.Equal(reference, parsed!.Adjustments.LensProfile);
            Assert.Equal(xml, XmpWriter.Serialize(parsed));
        }

        [Fact]
        public void EmptyReferenceIsOmittedAndReadsBackEmpty()
        {
            var xml = XmpWriter.Serialize(new XmpSidecarDocument());
            Assert.DoesNotContain("papp:LensProfile", xml);

            var explicitEmpty = XmpParser.Parse(xml.Replace(
                "papp:Profile=\"Auto\"", "papp:LensProfile=\"\"\n      papp:Profile=\"Auto\""));
            Assert.NotNull(explicitEmpty);
            Assert.Equal("", explicitEmpty!.Adjustments.LensProfile);
            Assert.DoesNotContain("papp:LensProfile", XmpWriter.Serialize(explicitEmpty));
        }

        [Fact]
        public void ReferenceIsModeledNotPassthrough()
        {
            var doc = new XmpSidecarDocument();
            doc.Adjustments.LensProfile = "lcp1:" + Digest;

            var parsed = XmpParser.Parse(XmpWriter.Serialize(doc));
            Assert.NotNull(parsed);
            Assert.DoesNotContain(parsed!.PassthroughAttributes, a => a.Name == "papp:LensProfile");
        }

        [Fact]
        public void FreeFormTextIsEscapedOnWriteAndRestoredOnRead()
        {
            // The core rejects anything but `lcp1(-ack):<hex>` at render time;
            // the sidecar layer itself is free-form, like papp:FilmLook.
            var doc = new XmpSidecarDocument();
            doc.Adjustments.LensProfile = "future:<a&b>\"quoted\"";

            var xml = XmpWriter.Serialize(doc);
            Assert.Contains("papp:LensProfile=\"future:&lt;a&amp;b&gt;&quot;quoted&quot;\"", xml);

            var parsed = XmpParser.Parse(xml);
            Assert.NotNull(parsed);
            Assert.Equal("future:<a&b>\"quoted\"", parsed!.Adjustments.LensProfile);
        }

        [Fact]
        public void FullFixtureRoundTripsTheReferenceWithEveryOtherField()
        {
            var written = WindowsFixtureModel.BuildDocument();
            var parsed = XmpParser.Parse(XmpWriter.Serialize(written));
            Assert.NotNull(parsed);
            Assert.Equal("lcp1-ack:" + Digest, parsed!.Adjustments.LensProfile);
            AdjustmentStateAssert.Equal(written.Adjustments, parsed.Adjustments);
        }

        [Fact]
        public void WebWrittenSidecarLoadsAndResavesByteIdentically()
        {
            // Exactly what the Web writer emits for a photo with an imported
            // profile, a lowered distortion strength and nothing else
            // (docs/xmp-canonical-format.md: same envelope, xmp/crs/papp
            // attribute order, alphabetical within a prefix).
            var webSidecar = string.Join("\n", new[]
            {
                "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
                "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
                "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
                "    <rdf:Description rdf:about=\"\"",
                "      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
                "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
                "      xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"",
                "      crs:HasSettings=\"True\"",
                "      crs:LensProfileDistortionScale=\"85\"",
                "      crs:ProcessVersion=\"11.0\"",
                "      crs:Version=\"11.0\"",
                $"      papp:LensProfile=\"lcp1:{Digest}\"",
                "      papp:Profile=\"Auto\"/>",
                "  </rdf:RDF>",
                "</x:xmpmeta>",
                "<?xpacket end=\"w\"?>",
            });

            var parsed = XmpParser.Parse(webSidecar);
            Assert.NotNull(parsed);
            Assert.Equal("lcp1:" + Digest, parsed!.Adjustments.LensProfile);
            Assert.Equal(85, parsed.Adjustments.LensCorrectionDistortion);
            Assert.Equal(ToggleMode.On, parsed.Adjustments.LensProfileEnable);

            Assert.Equal(webSidecar, XmpWriter.Serialize(parsed));
        }

        [Theory]
        [InlineData("lcp1:")]
        [InlineData("lcp1-ack:")]
        public void ReferenceSurvivesARealSidecarFile(string prefix)
        {
            var reference = prefix + Digest;
            var directory = Path.Combine(Path.GetTempPath(), "maple-lcp-xmp-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                var raw = Path.Combine(directory, "photo.dng");
                SidecarStore.Save(raw, new XmpSidecarDocument
                {
                    Adjustments = new AdjustmentState { LensProfile = reference, Exposure = 2 },
                });
                var loaded = SidecarStore.Load(raw);
                Assert.NotNull(loaded);
                Assert.Equal(reference, loaded!.Adjustments.LensProfile);
                Assert.Equal(2, loaded.Adjustments.Exposure);

                var before = File.ReadAllText(SidecarStore.SidecarPathFor(raw));
                SidecarStore.Save(raw, loaded);
                Assert.Equal(before, File.ReadAllText(SidecarStore.SidecarPathFor(raw)));
            }
            finally { Directory.Delete(directory, true); }
        }
    }
}
