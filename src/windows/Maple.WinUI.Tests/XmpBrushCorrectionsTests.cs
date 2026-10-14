using System;
using System.IO;
using System.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public sealed class XmpBrushCorrectionsTests : IDisposable
    {
        private readonly string directory = Path.Combine(Path.GetTempPath(), "maple-brush-corrections-" + Guid.NewGuid().ToString("N"));
        private string Raw => Path.Combine(directory, "photo.dng");
        private string SidecarPath => SidecarStore.SidecarPathFor(Raw);

        public XmpBrushCorrectionsTests()
        {
            Directory.CreateDirectory(directory);
            File.WriteAllBytes(Raw, new byte[] { 2, 3, 5, 7 });
        }

        public void Dispose() => Directory.Delete(directory, recursive: true);

        [Fact]
        public void UndoAfterResetRestoresBrushBeforeTheOriginalMaskGroupSlot()
        {
            File.WriteAllText(SidecarPath, XmpLayerOrderTests.AppleInterleaved(XmpLayerOrderTests.ModelIndexes));
            var original = Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
            var snapshot = XmpBrushCorrections.PassthroughContainers(original)!;
            var writes = new PendingLocalSidecarWrites();

            writes.Stage(Raw, new AdjustmentState(), 0, "none", null, discardBrushCorrections: true);
            Assert.Null(Assert.Single(writes.Flush()).Error);
            Assert.DoesNotContain("<papp:BrushCorrections", File.ReadAllText(SidecarPath));

            writes.Stage(Raw, original.Adjustments, 0, "none", null, restoreBrushCorrections: snapshot);
            Assert.Null(Assert.Single(writes.Flush()).Error);
            var restored = File.ReadAllText(SidecarPath);
            var brushIndex = restored.IndexOf("<papp:BrushCorrections", StringComparison.Ordinal);
            var groupIndex = restored.IndexOf("<crs:MaskGroupBasedCorrections", StringComparison.Ordinal);
            Assert.True(brushIndex >= 0 && groupIndex > brushIndex,
                "Reset undo must restore the brush container before the original mask-group slot.");
        }

        [Fact]
        public void BrushParserAcceptsMoreThan4096Dabs()
        {
            var dabs = string.Join(' ', Enumerable.Repeat("0.25 0.3 0.05 0.5 0.8 0", 5000));
            var brush = $"<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" papp:BrushVersion=\"1\" papp:BrushDigest=\"0123456789abcdef\" papp:Dabs=\"{dabs}\"/>";
            var correction = $"<rdf:li><rdf:Description crs:What=\"Correction\" crs:CorrectionAmount=\"1\" crs:CorrectionActive=\"True\"><crs:CorrectionMasks><rdf:Seq>{brush}</rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li>";
            var xml = XmpLocalAdjustmentsTests.Sidecar($"<papp:BrushCorrections><rdf:Seq>{correction}</rdf:Seq></papp:BrushCorrections>");

            var parsed = Assert.IsType<XmpSidecarDocument>(XmpParser.Parse(xml));
            var mask = Assert.IsType<BrushMask>(Assert.Single(parsed.Adjustments.LocalAdjustments).Mask);
            Assert.Equal(5000, mask.Dabs.Count);
        }
    }
}
