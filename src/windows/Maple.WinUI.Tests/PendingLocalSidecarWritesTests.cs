using Maple.WinUI.Models;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;
using Xunit;
using System.Xml.Linq;

namespace Maple.WinUI.Tests;

public sealed class PendingLocalSidecarWritesTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-pending-" + Guid.NewGuid());
    public PendingLocalSidecarWritesTests() => Directory.CreateDirectory(_root);

    [Fact]
    public void FailedPhotoSurvivesAnotherPhotoSaveAndRetryPreservesLatestMetadata()
    {
        var first = Path.Combine(_root, "first.dng");
        var second = Path.Combine(_root, "second.dng");
        File.WriteAllText(first, "original first");
        File.WriteAllText(second, "original second");
        var sidecar = SidecarStore.SidecarPathFor(first);
        File.WriteAllText(sidecar, "<broken");
        var queue = new PendingLocalSidecarWrites();
        var model = new AdjustmentState { Exposure = 1.25 };
        queue.Stage(first, model, 2, "pick", "blue");
        model.Exposure = 9;
        Assert.NotNull(Assert.Single(queue.Flush()).Error);
        Assert.Equal("<broken", File.ReadAllText(sidecar));
        queue.Stage(second, new AdjustmentState { Exposure = -0.5 }, 4, "none", null);
        var results = queue.Flush();
        Assert.NotNull(results.Single(r => r.Path == first).Error);
        Assert.Null(results.Single(r => r.Path == second).Error);
        var secondXml = File.ReadAllText(SidecarStore.SidecarPathFor(second));
        Assert.Equal(1.25, queue.ReadPending(first)!.Adjustments.Exposure);
        Assert.Null(queue.ReadPending(second));

        // Repair the invalid sidecar externally; retry must merge with this
        // latest document rather than replay an old full-document snapshot.
        File.WriteAllText(sidecar, """
            <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:vendor="urn:test" vendor:Keep="latest" xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:subject><rdf:Bag><rdf:li>external</rdf:li></rdf:Bag></dc:subject>
            </rdf:Description></rdf:RDF></x:xmpmeta>
            """);
        var recovered = Assert.Single(queue.Flush());
        Assert.Null(recovered.Error);
        var saved = SidecarStore.Load(first)!;
        Assert.Equal(1.25, saved.Adjustments.Exposure);
        Assert.Equal(2, saved.Rating);
        Assert.Equal("pick", saved.Flag);
        Assert.Equal("blue", saved.ColorLabel);
        Assert.Equal(new[] { "external" }, MetadataValues.Read(saved).Keywords);
        Assert.Contains("vendor:Keep=\"latest\"", recovered.Xml);
        Assert.Equal(secondXml, File.ReadAllText(SidecarStore.SidecarPathFor(second)));
        Assert.Equal("original first", File.ReadAllText(first));
        Assert.Equal("original second", File.ReadAllText(second));
        Assert.Empty(queue.Flush());
    }

    [Fact]
    public void ReeditingPendingPhotoReplacesItsSnapshotAndReadCannotMutateIt()
    {
        var path = Path.Combine(_root, "photo.dng");
        var queue = new PendingLocalSidecarWrites();
        queue.Stage(path, new AdjustmentState { Exposure = 1 }, 1, "none", null);
        queue.ReadPending(path)!.Adjustments.Exposure = 8;
        Assert.Equal(1, queue.ReadPending(path)!.Adjustments.Exposure);
        queue.Stage(path, new AdjustmentState { Exposure = 2 }, 5, "reject", "red");
        Assert.Null(Assert.Single(queue.Flush()).Error);
        var saved = SidecarStore.Load(path)!;
        Assert.Equal(2, saved.Adjustments.Exposure);
        Assert.Equal(5, saved.Rating);
        Assert.Equal("reject", saved.Flag);
        Assert.Equal("red", saved.ColorLabel);
    }

    [Fact]
    public void ResetWriteRemovesParsedBrushCorrectionsAndKeepsOtherPassthrough()
    {
        XNamespace papp = "http://ns.justmaple.app/photo/1.0/";
        XNamespace vendor = "urn:test";
        var path = Path.Combine(_root, "photo.dng");
        var sidecar = SidecarStore.SidecarPathFor(path);
        File.WriteAllText(sidecar, """
            <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" xmlns:vendor="urn:test">
              <vendor:keep>retained</vendor:keep>
              <papp:BrushCorrections><rdf:Seq><rdf:li><rdf:Description crs:CorrectionActive="True"><crs:CorrectionMasks><rdf:Seq><rdf:li crs:What="Mask/Paint" papp:BrushVersion="1" papp:Dabs="0.25 0.3 0.05 0.5 0.8 0"/></rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li></rdf:Seq></papp:BrushCorrections>
            </rdf:Description></rdf:RDF></x:xmpmeta>
            """);

        var queue = new PendingLocalSidecarWrites();
        queue.Stage(path, new AdjustmentState(), 0, "none", null, discardBrushCorrections: true);

        Assert.Null(Assert.Single(queue.Flush()).Error);
        var written = XDocument.Load(sidecar);
        Assert.Empty(written.Descendants(papp + "BrushCorrections"));
        Assert.Equal("retained", Assert.Single(written.Descendants(vendor + "keep")).Value);
    }

    [Fact]
    public void UndoAfterResetRestoresBrushContainerAndKeepsOtherPassthrough()
    {
        XNamespace papp = "http://ns.justmaple.app/photo/1.0/";
        XNamespace vendor = "urn:test";
        var path = Path.Combine(_root, "undo-photo.dng");
        var sidecar = SidecarStore.SidecarPathFor(path);
        File.WriteAllText(sidecar, """
            <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" xmlns:vendor="urn:test">
              <vendor:keep>retained</vendor:keep>
              <papp:BrushCorrections><rdf:Seq><rdf:li><rdf:Description crs:CorrectionActive="True"><crs:CorrectionMasks><rdf:Seq><rdf:li crs:What="Mask/Paint" papp:BrushVersion="1" papp:Dabs="0.25 0.3 0.05 0.5 0.8 0"/></rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li></rdf:Seq></papp:BrushCorrections>
            </rdf:Description></rdf:RDF></x:xmpmeta>
            """);

        var original = SidecarStore.Load(path)!;
        var brushContainers = XmpBrushCorrections.PassthroughContainers(original)!;
        Assert.Single(original.Adjustments.LocalAdjustments);
        Assert.Single(brushContainers.Containers);
        var queue = new PendingLocalSidecarWrites();
        queue.Stage(path, new AdjustmentState(), 0, "none", null, discardBrushCorrections: true);
        Assert.Null(Assert.Single(queue.Flush()).Error);
        Assert.Empty(XDocument.Load(sidecar).Descendants(papp + "BrushCorrections"));

        queue.Stage(path, original.Adjustments, 0, "none", null, restoreBrushCorrections: brushContainers);
        Assert.Null(Assert.Single(queue.Flush()).Error);
        var restored = SidecarStore.Load(path)!;
        Assert.Single(restored.Adjustments.LocalAdjustments);
        Assert.Single(XDocument.Load(sidecar).Descendants(papp + "BrushCorrections"));
        Assert.Equal("retained", Assert.Single(XDocument.Load(sidecar).Descendants(vendor + "keep")).Value);
    }

    public void Dispose() => Directory.Delete(_root, true);
}
