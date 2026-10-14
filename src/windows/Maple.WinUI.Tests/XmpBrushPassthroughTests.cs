// XmpBrushPassthroughTests — Lightroom paint remains opaque, while Maple
// brush corrections hydrate for live rendering and remain byte-stable through
// a Windows save (`docs/xmp-canonical-format.md` § "Brush masks").

using System;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Models;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpBrushPassthroughTests
    {
        private static readonly XNamespace Crs = "http://ns.adobe.com/camera-raw-settings/1.0/";
        private static readonly XNamespace Papp = "http://ns.justmaple.app/photo/1.0/";
        private static readonly XNamespace Rdf = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

        private const string MapleBrush =
            "<papp:BrushCorrections xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"><rdf:Seq><rdf:li>" +
            "<rdf:Description crs:What=\"Correction\" crs:CorrectionAmount=\"1\" crs:CorrectionActive=\"True\" crs:LocalExposure2012=\"0.5\" " +
            "papp:RangeKind=\"Color\" papp:RangeHue=\"61\" papp:RangeHueWidth=\"22\" papp:RangeChromaMin=\"0.03\" " +
            "papp:RangeLMin=\"0.2\" papp:RangeLMax=\"0.9\" papp:RangeFeather=\"0.25\">" +
            "<crs:CorrectionMasks><rdf:Seq><rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" papp:BrushVersion=\"1\" " +
            "papp:Dabs=\"0.25 0.3 0.05 0.5 0.8 0\" papp:BrushDigest=\"0123456789abcdef\"/></rdf:Seq></crs:CorrectionMasks>" +
            "</rdf:Description></rdf:li></rdf:Seq></papp:BrushCorrections>";

        private static XElement Only(XDocument doc, XName name)
        {
            var copy = new XElement(Assert.Single(doc.Descendants(name)));
            copy.DescendantsAndSelf().Attributes().Where(a => a.IsNamespaceDeclaration).Remove();
            return copy;
        }

        [Fact]
        public void LightroomPaintAndMapleBrushSurviveAWindowsSave()
        {
            var root = Assert.IsType<string>(RepoPaths.FindRepoRoot());
            var fixture = File.ReadAllText(Path.Combine(root, "test-fixtures", "local-adjustments", "lightroom-paint.xmp"));
            var close = fixture.LastIndexOf("</rdf:Description>", StringComparison.Ordinal);
            var source = fixture[..close] + MapleBrush + "\n  " + fixture[close..];
            var directory = Path.Combine(Path.GetTempPath(), "brush-passthrough-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                var raw = Path.Combine(directory, "photo.dng");
                File.WriteAllText(SidecarStore.SidecarPathFor(raw), source);
                var doc = Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(raw));
                var layer = Assert.Single(doc.Adjustments.LocalAdjustments);
                var brush = Assert.IsType<BrushMask>(layer.Mask);
                Assert.Equal("0123456789abcdef", brush.Digest);
                Assert.Single(brush.Dabs);
                Assert.Equal(new ColorRangeRefinement(61, 22, 0.03, 0.2, 0.9, 0.25), layer.Range);
                doc.Adjustments.Exposure = 1.25;
                SidecarStore.Save(raw, doc);

                var before = XDocument.Parse(source);
                var after = XDocument.Load(SidecarStore.SidecarPathFor(raw));
                Assert.True(XNode.DeepEquals(
                    Only(before, Crs + "PaintBasedCorrections"),
                    Only(after, Crs + "PaintBasedCorrections")));
                Assert.True(XNode.DeepEquals(
                    Only(before, Papp + "BrushCorrections"),
                    Only(after, Papp + "BrushCorrections")));
                Assert.Equal(1.25, Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(raw)).Adjustments.Exposure);
            }
            finally { Directory.Delete(directory, recursive: true); }
        }

        [Fact]
        public void NewerBrushVersionKeepsTheWholeContainerOpaque()
        {
            var xml = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"" + Rdf.NamespaceName + "\">" +
                "<rdf:Description xmlns:crs=\"" + Crs.NamespaceName + "\">" + MapleBrush +
                "</rdf:Description></rdf:RDF></x:xmpmeta>";
            var source = XDocument.Parse(xml);
            var container = Assert.Single(source.Descendants(Papp + "BrushCorrections"));
            var sequence = Assert.Single(container.Elements(Rdf + "Seq"));
            var newerCorrection = new XElement(Assert.Single(sequence.Elements(Rdf + "li")));
            newerCorrection.DescendantsAndSelf().Attributes(Papp + "BrushVersion").Single().Value = "2";
            sequence.Add(newerCorrection);

            var parsed = Assert.IsType<XmpSidecarDocument>(XmpParser.Parse(source.ToString()));
            Assert.Empty(parsed.Adjustments.LocalAdjustments);
        }

        [Theory]
        [InlineData("crs:What=\"Other\"", "crs:CorrectionActive=\"True\"", true)]
        [InlineData("", "crs:CorrectionActive=\"True\"", true)]
        [InlineData("crs:What=\"Correction\"", "crs:CorrectionActive=\"0\"", false)]
        [InlineData("crs:What=\"Correction\"", "crs:CorrectionActive=\"Off\"", false)]
        [InlineData("crs:What=\"Correction\"", "crs:CorrectionActive=\"false\"", false)]
        [InlineData("crs:What=\"Correction\"", "crs:CorrectionActive=\"unknown\"", true)]
        public void CorrectionBookkeepingAndAdobeBooleanSpellingsAreHandled(string what, string active, bool expectedActive)
        {
            var brush = (what.Length == 0
                    ? MapleBrush.Replace("crs:What=\"Correction\"", string.Empty, StringComparison.Ordinal)
                    : MapleBrush.Replace("crs:What=\"Correction\"", what, StringComparison.Ordinal))
                .Replace("crs:CorrectionActive=\"True\"", active, StringComparison.Ordinal);
            var parsed = ParseBrushDocument(brush);
            Assert.Equal(expectedActive, parsed.Adjustments.LocalAdjustments.Count == 1);
        }

        [Fact]
        public void DabValuesThatOverflowTheNativeFloatWireKeepTheContainerOpaque()
        {
            var brush = MapleBrush.Replace(
                "papp:Dabs=\"0.25 0.3 0.05 0.5 0.8 0\"",
                "papp:Dabs=\"1e100 0.3 0.05 0.5 0.8 0\"",
                StringComparison.Ordinal);

            Assert.Empty(ParseBrushDocument(brush).Adjustments.LocalAdjustments);
        }

        [Fact]
        public void OneInactiveCorrectionDropsTheEntireBrushContainer()
        {
            const string inactiveCorrection =
                "<rdf:li><rdf:Description crs:CorrectionActive=\"False\"><crs:CorrectionMasks><rdf:Seq>" +
                "<rdf:li crs:What=\"Mask/Paint\" papp:BrushVersion=\"1\" papp:Dabs=\"0.25 0.3 0.05 0.5 0.8 0\"/>" +
                "</rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li>";
            var mixed = MapleBrush.Replace(
                "</rdf:li></rdf:Seq></papp:BrushCorrections>",
                "</rdf:li>" + inactiveCorrection + "</rdf:Seq></papp:BrushCorrections>",
                StringComparison.Ordinal);

            Assert.Empty(ParseBrushDocument(mixed).Adjustments.LocalAdjustments);
        }

        [Fact]
        public void OverLimitDabSeriesRemainOpaqueWithoutAllocatingPerToken()
        {
            var dabs = string.Join(' ', Enumerable.Repeat("0", 6 * 4097));
            var brush = MapleBrush.Replace(
                "papp:Dabs=\"0.25 0.3 0.05 0.5 0.8 0\"",
                $"papp:Dabs=\"{dabs}\"",
                StringComparison.Ordinal);

            Assert.Empty(ParseBrushDocument(brush).Adjustments.LocalAdjustments);
        }

        [Fact]
        public void MissingBrushDigestGetsTheWindowsRegistryKey()
        {
            var brush = MapleBrush.Replace(" papp:BrushDigest=\"0123456789abcdef\"", string.Empty, StringComparison.Ordinal);

            Assert.Equal("fd119d40ee8103ea", Assert.IsType<BrushMask>(
                Assert.Single(ParseBrushDocument(brush).Adjustments.LocalAdjustments).Mask).Digest);
        }

        private static XmpSidecarDocument ParseBrushDocument(string brush) => Assert.IsType<XmpSidecarDocument>(
            XmpParser.Parse("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"" + Rdf.NamespaceName +
                "\"><rdf:Description xmlns:crs=\"" + Crs.NamespaceName + "\">" + brush +
                "</rdf:Description></rdf:RDF></x:xmpmeta>"));

        [Fact]
        public void BrushFingerprintTracksRenderedContentButIgnoresRuntimeRasterId()
        {
            var xml = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"" + Rdf.NamespaceName + "\">" +
                "<rdf:Description xmlns:crs=\"" + Crs.NamespaceName + "\">" + MapleBrush +
                "</rdf:Description></rdf:RDF></x:xmpmeta>";
            var model = Assert.IsType<XmpSidecarDocument>(XmpParser.Parse(xml)).Adjustments;
            var originalXmp = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = model });
            var originalFingerprint = XmpWriter.Fingerprint(model);

            var withRuntimeRaster = model.Clone();
            var originalLayer = withRuntimeRaster.LocalAdjustments[0];
            var originalBrush = Assert.IsType<BrushMask>(originalLayer.Mask);
            withRuntimeRaster.LocalAdjustments[0] = originalLayer with
            {
                Mask = originalBrush with { RasterId = 91 },
            };
            Assert.Equal(originalFingerprint, XmpWriter.Fingerprint(withRuntimeRaster));

            var changedBrushModel = model.Clone();
            var changedLayer = changedBrushModel.LocalAdjustments[0];
            var changedBrush = Assert.IsType<BrushMask>(changedLayer.Mask);
            changedBrushModel.LocalAdjustments[0] = changedLayer with
            {
                Mask = changedBrush with
                {
                    Dabs = new[] { changedBrush.Dabs[0] with { Weight = 0.3 } },
                },
                Adjustments = changedLayer.Adjustments with { Exposure = 1.25 },
            };
            Assert.Equal(originalXmp, XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = changedBrushModel }));
            Assert.NotEqual(originalFingerprint, XmpWriter.Fingerprint(changedBrushModel));
        }
    }
}
