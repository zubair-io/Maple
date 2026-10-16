using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class ImportedWhiteBalanceTests
{
    private static string Xml(string attributes) =>
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:WhiteBalance=\"Auto\" " + attributes + "/></rdf:RDF></x:xmpmeta>";

    [ImportedWhiteBalanceNativeFact]
    public void NativeColdResolverMatchesTheSharedEstimatorAndCachesThePair()
    {
        System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var source = Path.Combine(AppContext.BaseDirectory, "Fixtures", "source.dng");
        var bytes = File.ReadAllBytes(source);
        var directory = Path.Combine(Path.GetTempPath(), $"maple-auto-wb-native-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var raw = Path.Combine(directory, "source.dng");
            var sidecar = Path.Combine(directory, "source.xmp");
            File.WriteAllBytes(raw, bytes);
            File.WriteAllText(sidecar, Xml(""));
            var doc = XmpParser.Parse(File.ReadAllText(sidecar))!;
            Assert.Equal(0, RawFfi.maple_compute_auto_adjustments(raw, null, 1, out var expected));
            ImportedWhiteBalanceResolver.ResolveInPlace(raw, doc.Adjustments);
            Assert.Equal((double)expected.temperature, doc.Adjustments.Temperature);
            Assert.Equal((double)expected.tint, doc.Adjustments.Tint);
            Assert.Equal(0, doc.Adjustments.Exposure);
            Assert.Equal(bytes, File.ReadAllBytes(raw));
            Assert.Equal(Xml(""), File.ReadAllText(sidecar));
            // Reusing a resolved model must not open or estimate the RAW again.
            ImportedWhiteBalanceResolver.ResolveInPlace("/not-a-file.dng", doc.Adjustments);
            Assert.Equal((double)expected.temperature, doc.Adjustments.Temperature);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData("")]
    [InlineData("crs:Temperature=\"6500\"")]
    [InlineData("crs:Tint=\"0\"")]
    [InlineData("crs:Temperature=\"8500\"")]
    public void RealSidecarRetainsAbsentAxesAfterHydrationAndUnrelatedSave(string attributes)
    {
        var path = Path.Combine(Path.GetTempPath(), $"maple-imported-wb-{Guid.NewGuid():N}.xmp");
        try
        {
            File.WriteAllText(path, Xml(attributes));
            var doc = XmpParser.Parse(File.ReadAllText(path))!;
            var original = Assert.IsType<ImportedWhiteBalance>(doc.Adjustments.ImportedWhiteBalance);
            doc.Adjustments.ImportedWhiteBalance = original with { Resolved = new(5520, -43.79) };
            ImportedWhiteBalanceResolver.ResolveInPlace("/no-analysis-required.dng", doc.Adjustments);
            doc.Adjustments.Exposure = 1.25;
            File.WriteAllText(path, XmpWriter.Serialize(doc));
            var saved = File.ReadAllText(path);
            Assert.Contains("crs:WhiteBalance=\"Auto\"", saved);
            if (original.Temperature == null) Assert.DoesNotContain("crs:Temperature=", saved);
            if (original.Tint == null) Assert.DoesNotContain("crs:Tint=", saved);
            if (attributes.Length > 0) Assert.Contains(attributes, saved);
            Assert.Equal(original, XmpParser.Parse(saved)!.Adjustments.ImportedWhiteBalance);
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void ExplicitDefaultPairNeverBecomesAnUnresolvedAutoRequest()
    {
        var doc = XmpParser.Parse(Xml("crs:Temperature=\"6500\" crs:Tint=\"0\""))!;
        Assert.Null(doc.Adjustments.ImportedWhiteBalance);
        var saved = XmpWriter.Serialize(doc);
        Assert.Contains("crs:Temperature=\"6500\"", saved);
        Assert.Contains("crs:Tint=\"0\"", saved);
        Assert.Null(XmpParser.Parse(saved)!.Adjustments.ImportedWhiteBalance);
    }

    [Fact]
    public void EditingResolvedLegacyPartialPairWritesCurrentScaleAndUndoPreservesImportScale()
    {
        var doc = XmpParser.Parse(Xml("crs:Temperature=\"5700\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:WbScaleVersion=\"2\""))!;
        doc.Adjustments.ImportedWhiteBalance = doc.Adjustments.ImportedWhiteBalance! with { Resolved = new(5690, 12) };
        ImportedWhiteBalanceResolver.ResolveInPlace("/no-analysis-required.dng", doc.Adjustments);
        var undo = doc.Adjustments.Clone();
        WhiteBalanceProvenance.SetManualTint(doc.Adjustments, 19);
        Assert.Contains("papp:WbScaleVersion=\"5\"", XmpWriter.Serialize(doc));
        doc.Adjustments = undo;
        var restored = XmpWriter.Serialize(doc);
        Assert.Contains("papp:WbScaleVersion=\"2\"", restored);
        Assert.Contains("crs:Temperature=\"5700\"", restored);
        Assert.DoesNotContain("crs:Tint=", restored);
    }

    [Fact]
    public void CustomPreservesTheCurrentCoordinateScaleAndNewEstimatesReplaceIt()
    {
        var doc = XmpParser.Parse(Xml("crs:Temperature=\"5700\" crs:Tint=\"12\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:WbScaleVersion=\"1\""))!;
        Assert.True(WhiteBalanceProvenance.ApplyNamedPreset(doc.Adjustments, "Custom"));
        Assert.Contains("papp:WbScaleVersion=\"1\"", XmpWriter.Serialize(doc));
        Assert.Equal((5700, 12), (doc.Adjustments.Temperature, doc.Adjustments.Tint));
        WhiteBalanceProvenance.SetManualTint(doc.Adjustments, 19);
        Assert.Contains("papp:WbScaleVersion=\"1\"", XmpWriter.Serialize(doc));
        Assert.True(WhiteBalanceProvenance.ApplyNamedPreset(doc.Adjustments, "Daylight"));
        Assert.Contains("papp:WbScaleVersion=\"5\"", XmpWriter.Serialize(doc));
        doc.WbScaleVersion = 1;
        WhiteBalanceProvenance.MarkAuto(doc.Adjustments);
        Assert.Equal(5, doc.WbScaleVersion);
        doc.WbScaleVersion = 1;
        WhiteBalanceProvenance.ApplyAsShot(doc.Adjustments, 5200, 15);
        Assert.Equal(5, doc.WbScaleVersion);
    }

    [Fact]
    public void PublicationHydratesMatchingUndoSnapshotsAndPreservesInterveningEdits()
    {
        var original = XmpParser.Parse(Xml(""))!.Adjustments;
        var resolved = original.Clone();
        resolved.ImportedWhiteBalance = resolved.ImportedWhiteBalance! with { Resolved = new(5300, 17) };
        var undo = original.Clone();
        ImportedWhiteBalanceResolver.ApplyResolved(undo, resolved);
        Assert.Equal((5300, 17), (undo.Temperature, undo.Tint));
        Assert.NotNull(undo.ImportedWhiteBalance);
        WhiteBalanceProvenance.SetManualTemperature(original, 4500);
        ImportedWhiteBalanceResolver.ApplyResolved(original, resolved);
        Assert.Equal(4500, original.Temperature);
        Assert.Null(original.ImportedWhiteBalance);
        var stripped = RenderEngine.StripChainStages(undo);
        Assert.Null(stripped.ImportedWhiteBalance);
        Assert.Equal("Custom", stripped.WhiteBalancePreset);
        Assert.Equal((6500, 0), (stripped.Temperature, stripped.Tint));
    }
}

public sealed class ImportedWhiteBalanceNativeFactAttribute : FactAttribute
{
    public ImportedWhiteBalanceNativeFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
            Skip = "Requires the built Rust library through MAPLE_RAW_FFI_DLL.";
    }
}
