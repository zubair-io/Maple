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
    }
}
