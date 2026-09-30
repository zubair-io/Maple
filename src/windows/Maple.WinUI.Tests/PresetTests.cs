using System.Text.Json;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public class PresetTests
{
    private static PresetDocument Read(string fields) => PresetDocument.Parse("{\"schemaVersion\":1,\"name\":\"Test\",\"fields\":" + fields + "}");

    [Fact]
    public void FutureFieldsAndTopLevelDocumentsSurviveRoundTrip()
    {
        var preset = PresetDocument.Parse("""
            {"id":"future","schemaVersion":8,"name":"Future","fields":{"contrast":25,"future_color":true,"film_look":"future-film"},"vendor":{"nested":[null,1,"kept"]}}
            """);
        var reopened = PresetDocument.Parse(preset.Serialize());
        Assert.Equal(8, reopened.SchemaVersion);
        Assert.Equal("future", reopened.Id);
        Assert.True(reopened.Fields["future_color"].GetBoolean());
        Assert.Equal("future-film", reopened.Fields["film_look"].GetString());
        Assert.Equal("kept", reopened.Extra["vendor"].GetProperty("nested")[2].GetString());
    }

    [Theory]
    [InlineData("{\"contrast\":null}")]
    [InlineData("{\"contrast\":[1,2]}")]
    [InlineData("{\"future\":{\"x\":1}}")]
    [InlineData("{\"exposure\":1e400}")]
    [InlineData("{\"contrast\":1,\"contrast\":2}")]
    public void InvalidFieldsAreRejectedRatherThanLost(string fields) => Assert.Throws<InvalidDataException>(() => Read(fields));

    [Theory]
    [InlineData("null")]
    [InlineData("\"1\"")]
    [InlineData("true")]
    [InlineData("1.5")]
    [InlineData("0")]
    public void InvalidSchemaVersionsHaveAnActionableValidationError(string version) =>
        Assert.Throws<InvalidDataException>(() => PresetDocument.Parse("{\"schemaVersion\":" + version + ",\"name\":\"Invalid\",\"fields\":{}}"));

    [Fact]
    public void SparseApplyClampsOnlyNamedSupportedFieldsAndDisclosesSkippedValues()
    {
        var original = new AdjustmentState { Exposure = 1.2, Contrast = 10, LensProfile = "keep", WbSampleX = .7 };
        original.Crop = new(.1, .1, .8, .8, 2);
        original.ToneCurveLuma.Add(new(.25, .4));
        var fields = Read("""
            {"contrast":999,"tint":true,"profile":"Future","lens_profile":"replace","wb_sample_x":0.1,"demosaic":"Rcd","new_field":42}
            """).Fields;
        var result = AdjustmentFieldBridge.Apply(original, fields);
        Assert.Equal(100, result.State.Contrast);
        Assert.Equal("Rcd", result.State.Demosaic);
        Assert.Equal(1.2, result.State.Exposure);
        Assert.Equal("keep", result.State.LensProfile);
        Assert.Equal(.7, result.State.WbSampleX);
        Assert.Equal(original.Crop, result.State.Crop);
        Assert.Equal(original.ToneCurveLuma, result.State.ToneCurveLuma);
        Assert.Equal(10, original.Contrast);
        Assert.Equal(new[] { "contrast", "demosaic" }, result.Applied);
        Assert.Equal(new[] { "tint", "profile", "lens_profile", "wb_sample_x", "new_field" }, result.Skipped);
    }

    [Fact]
    public void CaptureIsSparseAndUsesGeneratedDefaultsAndExclusions()
    {
        var state = new AdjustmentState { Exposure = 1, FilmLook = "future-look", WbSampleX = .6, LensProfile = "do-not-copy" };
        var captured = AdjustmentFieldBridge.Capture(state);
        Assert.Equal(new[] { "exposure", "film_look" }, captured.Keys);
        Assert.Empty(AdjustmentFieldBridge.Capture(new AdjustmentState()));
        foreach (var spec in AdjustmentFields.All.Where(f => f.Kind == "Number"))
        {
            var member = typeof(AdjustmentState).GetField(spec.Member);
            if (member != null) Assert.Equal(spec.DefaultNumber, (double)member.GetValue(new AdjustmentState())!);
        }
        Assert.All(AdjustmentFields.All, spec => Assert.False(string.IsNullOrWhiteSpace(spec.TransferMode)));
    }

    [Fact]
    public void ResetPreservesFieldsThatApplyRejectedAndDisclosesThem()
    {
        var original = new AdjustmentState { Contrast = 35, Tint = 22, Exposure = 1.25, Demosaic = "Rcd" };
        var preset = Read("""
            {"contrast":-50,"tint":true,"demosaic":"FutureKernel","future_setting":7}
            """);
        var applied = AdjustmentFieldBridge.Apply(original, preset.Fields);
        var reset = AdjustmentFieldBridge.Reset(applied.State, preset.Fields);
        Assert.Equal(new[] { "contrast" }, reset.Applied);
        Assert.Equal(new[] { "tint", "demosaic", "future_setting" }, reset.Skipped);
        Assert.Equal(0, reset.State.Contrast);
        Assert.Equal(22, reset.State.Tint);
        Assert.Equal("Rcd", reset.State.Demosaic);
        Assert.Equal(1.25, reset.State.Exposure);
        Assert.Equal(-50, applied.State.Contrast);
    }

    [Fact]
    public void ResetAffectsOnlyPresetFieldsAndAppliedValuesPersistInXmp()
    {
        var original = new AdjustmentState { Exposure = 1.25, Contrast = 35, Saturation = 10 };
        var fields = Read("{\"contrast\":-50,\"demosaic\":\"Lmmse\",\"film_strength\":40}").Fields;
        var applied = AdjustmentFieldBridge.Apply(original, fields);
        var document = new XmpSidecarDocument { Adjustments = applied.State, Rating = 4, ColorLabel = "blue" };
        var reopened = XmpParser.Parse(XmpWriter.Serialize(document));
        Assert.NotNull(reopened);
        Assert.Equal(-50, reopened.Adjustments.Contrast);
        Assert.Equal("Lmmse", reopened.Adjustments.Demosaic);
        Assert.Equal(1.25, reopened.Adjustments.Exposure);
        Assert.Equal(4, reopened.Rating);
        var reset = AdjustmentFieldBridge.Reset(applied.State, fields);
        Assert.Equal(0, reset.State.Contrast);
        Assert.Equal(100, reset.State.FilmStrength);
        Assert.Equal("Auto", reset.State.Demosaic);
        Assert.Equal(1.25, reset.State.Exposure);
        Assert.Equal(10, reset.State.Saturation);
    }
}
