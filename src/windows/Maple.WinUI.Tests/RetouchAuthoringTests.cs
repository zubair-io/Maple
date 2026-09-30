using System.Xml.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class RetouchNativeFactAttribute : FactAttribute
{
    public RetouchNativeFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL"))
            || string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RETOUCH_TEST_RAW")))
            Skip = "Requires the native DLL and an explicit RAW fixture with spatial detail.";
    }
}

public class RetouchAuthoringTests
{
    private static readonly RetouchSpot Spot = new(RetouchKind.Heal, .25, .5, .75, .5, .025);

    [RetouchNativeFact]
    public void ReopenedRepairsUseTheSharedNativeDecodeAndLeaveOriginalUntouched()
    {
        System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var path = Environment.GetEnvironmentVariable("MAPLE_RETOUCH_TEST_RAW")!;
        var hash = System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path));
        var model = new AdjustmentState { Profile = ProfileMode.Neutral };
        model.Retouch = XmpRetouch.Add(model.Retouch, Spot with { Kind = RetouchKind.Clone, Radius = .15 });
        model.Retouch = XmpRetouch.Add(model.Retouch, Spot with { X = .5, SourceX = .2, Radius = .1 });
        var reopened = XmpParser.Parse(XmpWriter.Serialize(new() { Adjustments = model }))!.Adjustments;
        var first = RenderEngine.Decode(path, model, 256, RefineDecodeQuality.Preview, IntPtr.Zero);
        var second = RenderEngine.Decode(path, reopened, 256, RefineDecodeQuality.Preview, IntPtr.Zero);
        var unedited = RenderEngine.Decode(path, new AdjustmentState { Profile = ProfileMode.Neutral }, 256, RefineDecodeQuality.Preview, IntPtr.Zero);
        Assert.True(first.Pixels.Where((value, index) => Math.Abs(value - unedited.Pixels[index]) > 1e-6).Any(),
            "The supplied fixture must contain spatial detail and the repair must change decoded pixels.");
        Assert.Equal(first.Pixels, second.Pixels);
        Assert.All(first.Pixels, value => Assert.True(float.IsFinite(value)));
        Assert.Equal(hash, System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)));
    }

    [Fact]
    public void AuthoredSpotsReopenWithoutMutatingUndoSnapshot()
    {
        var original = new AdjustmentState();
        var edited = original.Clone();
        edited.Retouch = XmpRetouch.Add(edited.Retouch, Spot);
        var saved = XmpWriter.Serialize(new() { Adjustments = edited });
        var reopened = XmpParser.Parse(saved)!;
        Assert.Empty(original.Retouch.Spots);
        Assert.Equal(Spot, Assert.Single(reopened.Adjustments.Retouch.Spots).Spot);
        Assert.Contains("crs:Radius=\"0.025000\"", saved);
        Assert.Equal(saved, XmpWriter.Serialize(reopened));
        Assert.True(RenderEngine.DecodeInputsChanged(original, edited));
        var exposure = edited.Clone();
        exposure.Exposure = 1;
        Assert.False(RenderEngine.DecodeInputsChanged(edited, exposure));
        Assert.Equal(edited.Retouch.Xml, RenderEngine.StripChainStages(edited).Retouch.Xml);
    }

    [Fact]
    public void EditAndDeleteRetainUnknownSpotsAndExtensions()
    {
        var state = XmpRetouch.Add(RetouchState.Empty, Spot);
        var root = XElement.Parse(state.Xml!);
        XNamespace rdf = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
        XNamespace crs = "http://ns.adobe.com/camera-raw-settings/1.0/";
        var seq = root.Element(rdf + "Seq")!;
        seq.AddFirst(new XElement(rdf + "li", new XAttribute(crs + "SpotType", "future"), new XElement("unknown", "keep")));
        var desc = seq.Elements().Last().Element(rdf + "Description")!;
        desc.Add(new XElement("extra", "retained"));
        state = XmpRetouch.Read(root);
        var updated = XmpRetouch.Replace(state, 0, Spot with { Kind = RetouchKind.Clone, SourceX = .8 });
        Assert.Contains("<unknown>keep</unknown>", updated.Xml);
        Assert.Contains("<extra>retained</extra>", updated.Xml);
        Assert.Equal(RetouchKind.Clone, Assert.Single(updated.Spots).Spot.Kind);
        Assert.Equal(RetouchKind.Heal, Assert.Single(state.Spots).Spot.Kind);
        var removed = XmpRetouch.Remove(updated, 0);
        Assert.Empty(removed.Spots);
        Assert.Contains("<unknown>keep</unknown>", removed.Xml);
    }

    [Fact]
    public void OffsetSourcesAndMaskFeatherFollowSharedPrecedence()
    {
        var root = XElement.Parse(XmpRetouch.Add(RetouchState.Empty, Spot).Xml!);
        XNamespace crs = "http://ns.adobe.com/camera-raw-settings/1.0/";
        var desc = root.Descendants().Single(e => e.Attribute(crs + "SpotType") != null);
        desc.Attribute(crs + "SourceX")!.Remove(); desc.Attribute(crs + "SourceY")!.Remove();
        desc.SetAttributeValue(crs + "OffsetX", .1); desc.SetAttributeValue(crs + "OffsetY", -.1);
        root.Descendants().Single(e => e.Attribute(crs + "Radius") != null).SetAttributeValue(crs + "Feather", .75);
        var state = XmpRetouch.Read(root);
        Assert.Equal(.35, state.Spots[0].Spot.SourceX, 6);
        Assert.Equal(.4, state.Spots[0].Spot.SourceY, 6);
        Assert.Equal(.75, state.Spots[0].Spot.Feather);
        var changed = XmpRetouch.Replace(state, 0, state.Spots[0].Spot with { Feather = .25 });
        Assert.Equal(.25, changed.Spots[0].Spot.Feather);
    }

    [Fact]
    public void InvalidAuthoredGeometryCannotReachSidecar()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => XmpRetouch.Add(RetouchState.Empty, Spot with { Radius = 0 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => XmpRetouch.Add(RetouchState.Empty, Spot with { X = double.NaN }));
    }

    [Fact]
    public void CrossImageTransferKeepsTargetRepairs()
    {
        var source = new AdjustmentState { Retouch = XmpRetouch.Add(RetouchState.Empty, Spot) };
        var target = new XmpSidecarDocument();
        target.Adjustments.Retouch = XmpRetouch.Add(RetouchState.Empty, Spot with { X = .1 });
        var before = target.Adjustments.Retouch.Xml;
        var patch = AdjustmentTransfer.Build(new(source, 5, null), Maple.WinUI.Generated.AdjustmentFields.Groups.Select(g => g.Id));
        AdjustmentTransfer.Apply(target, patch);
        Assert.Equal(before, target.Adjustments.Retouch.Xml);
        Assert.DoesNotContain("retouch_spots", patch.Fields.Keys);
    }

    [Fact]
    public void LegacyImportsButStructuredContainerWins()
    {
        var xml = XmpWriter.Serialize(new());
        var legacy = "<crs:RetouchInfo><rdf:Seq><rdf:li>centerX = 0.25, centerY = 0.5, radius = 0.025, sourceX = 0.75, sourceY = 0.5, spotType = heal</rdf:li><rdf:li>spotType = future, payload = preserve</rdf:li></rdf:Seq></crs:RetouchInfo>";
        var document = XDocument.Parse(xml);
        var fragment = XElement.Parse("<root xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">" + legacy + "</root>");
        document.Descendants().Single(e => e.Name.LocalName == "Description").Add(fragment.Elements());
        xml = document.ToString();
        var doc = XmpParser.Parse(xml)!;
        Assert.Equal(Spot, Assert.Single(doc.Adjustments.Retouch.Spots).Spot);
        doc.Adjustments.Retouch = XmpRetouch.Replace(doc.Adjustments.Retouch, 0, Spot with { Kind = RetouchKind.Clone });
        var saved = XmpWriter.Serialize(doc);
        Assert.Contains("payload = preserve", saved);
        Assert.Equal(RetouchKind.Clone, Assert.Single(XmpParser.Parse(saved)!.Adjustments.Retouch.Spots).Spot.Kind);
    }
}
