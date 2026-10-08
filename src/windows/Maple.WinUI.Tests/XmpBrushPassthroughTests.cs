// XmpBrushPassthroughTests — Windows models neither Lightroom's
// `crs:PaintBasedCorrections` nor Maple's `papp:BrushCorrections` (#360), so
// both must survive a Windows edit and save as passthrough
// (`docs/xmp-canonical-format.md` § "Brush masks").

using System;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class XmpBrushPassthroughTests
    {
        private static readonly XNamespace Crs = "http://ns.adobe.com/camera-raw-settings/1.0/";
        private static readonly XNamespace Papp = "http://ns.justmaple.app/photo/1.0/";

        private const string MapleBrush =
            "<papp:BrushCorrections xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"><rdf:Seq><rdf:li>" +
            "<rdf:Description crs:What=\"Correction\" crs:CorrectionAmount=\"1\" crs:CorrectionActive=\"True\" crs:LocalExposure2012=\"0.5\">" +
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
                Assert.Empty(doc.Adjustments.LocalAdjustments);
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
    }
}
