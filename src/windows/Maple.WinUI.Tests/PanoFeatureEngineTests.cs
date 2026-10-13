using System.Linq;
using System.Text.Json;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Pano;
using Xunit;

namespace Maple.WinUI.Tests;

public class PanoFeatureEngineTests
{
    private const string ModelsDir = @"C:\Maple\pano-models";
    private const string OrtPath = @"C:\Maple\ort\x64\onnxruntime.dll";

    private static PanoStitchCommand Command(PanoFeatureEngine engine) => PanoStitchCommand.Build(
        new[] { @"C:\pano\a.dng", "--strategy" },
        @"C:\pano\out-master.png", @"C:\pano\out.png",
        "keep", "mesh", "auto", null, engine, ModelsDir, OrtPath);

    [Fact]
    public void FreshSettingsChooseTheClassicalMatcher()
    {
        Assert.False(new AppSettings().PanoUseMlMatcher);
        Assert.Equal(PanoFeatureEngine.Classical, PanoFeatureEngines.FromSetting(new AppSettings().PanoUseMlMatcher));
    }

    [Fact]
    public void SettingsFileWrittenBeforeTheToggleExistedStaysClassical()
    {
        var legacy = JsonSerializer.Deserialize<AppSettings>("{\"PanoModelsDir\":\"D:\\\\models\"}")!;
        Assert.False(legacy.PanoUseMlMatcher);
    }

    [Fact]
    public void ToggleOnSelectsTheMlMatcher() =>
        Assert.Equal(PanoFeatureEngine.Ml, PanoFeatureEngines.FromSetting(true));

    [Fact]
    public void ClassicalStitchNeedsNoModelsOrOnnxRuntime()
    {
        var command = Command(PanoFeatureEngine.Classical);
        var args = command.Arguments.ToList();
        Assert.Equal("classical", args[args.IndexOf("--features-engine") + 1]);
        Assert.DoesNotContain("--models-dir", args);
        Assert.Empty(command.Environment);
    }

    [Fact]
    public void MlStitchPointsTheCliAtTheProvisionedRuntime()
    {
        var command = Command(PanoFeatureEngine.Ml);
        var args = command.Arguments.ToList();
        Assert.Equal("ml", args[args.IndexOf("--features-engine") + 1]);
        Assert.Equal(ModelsDir, args[args.IndexOf("--models-dir") + 1]);
        Assert.Equal(ModelsDir, command.Environment["MAPLE_PANO_MODELS"]);
        Assert.Equal(OrtPath, command.Environment["ORT_DYLIB_PATH"]);
    }

    [Theory]
    [InlineData(PanoFeatureEngine.Classical)]
    [InlineData(PanoFeatureEngine.Ml)]
    public void FramePathsFollowTheOptionTerminator(PanoFeatureEngine engine)
    {
        var args = Command(engine).Arguments.ToList();
        Assert.Equal(new[] { "pano", "stitch" }, args.Take(2));
        Assert.Equal(new[] { "--", @"C:\pano\a.dng", "--strategy" }, args.TakeLast(3));
        Assert.Equal(1, args.Count(a => a == "--"));
    }

    [Theory]
    [InlineData(PanoFeatureEngine.Classical)]
    [InlineData(PanoFeatureEngine.Ml)]
    public void PreviewAndStitchRunTheSameEngine(PanoFeatureEngine engine)
    {
        var stitch = PanoStitchCommand.Build(
            new[] { @"C:\pano\a.dng" }, @"C:\pano\out-master.png", @"C:\pano\out.png",
            "keep", "mesh", "auto", @"C:\t\alignment-1.json", engine, ModelsDir, OrtPath);
        var preview = PanoPreviewCommand.Build(
            new[] { @"C:\pano\a.dng" }, new PanoPreviewFiles(@"C:\t\preview-1.png", @"C:\t\alignment-1.json"),
            null, new PanoPreviewOptions("keep", "mesh", "auto"), engine, ModelsDir, OrtPath);
        string? ValueOf(System.Collections.Generic.IReadOnlyList<string> args, string flag)
        {
            var at = args.ToList().IndexOf(flag);
            return at < 0 ? null : args[at + 1];
        }
        Assert.Equal(ValueOf(preview.Arguments, "--features-engine"), ValueOf(stitch.Arguments, "--features-engine"));
        Assert.Equal(ValueOf(preview.Arguments, "--models-dir"), ValueOf(stitch.Arguments, "--models-dir"));
        Assert.Equal(preview.Environment, stitch.Environment);
        Assert.Equal(@"C:\t\alignment-1.json", ValueOf(stitch.Arguments, "--alignment-in"));
    }

    [Fact]
    public void ClassicalIsReadyWithOnlyTheCli()
    {
        var state = new PanoProvisionState(PanoFeatureEngine.Classical, Cli: true, Models: false, Ort: false);
        Assert.False(state.NeedsDownload);
        Assert.True(state.IsReady);
        Assert.DoesNotContain("ONNX", state.Summary);
    }

    [Fact]
    public void UnprovisionedMlNeedsTheDownload()
    {
        var state = new PanoProvisionState(PanoFeatureEngine.Ml, Cli: true, Models: true, Ort: false);
        Assert.True(state.NeedsDownload);
        Assert.False(state.IsReady);
        Assert.Contains("ONNX Runtime: missing", state.Summary);
    }

    [Fact]
    public void ProvisionedMlIsReady()
    {
        var state = new PanoProvisionState(PanoFeatureEngine.Ml, Cli: true, Models: true, Ort: true);
        Assert.False(state.NeedsDownload);
        Assert.True(state.IsReady);
    }

    [Theory]
    [InlineData(PanoFeatureEngine.Classical)]
    [InlineData(PanoFeatureEngine.Ml)]
    public void MissingCliIsNeverReady(PanoFeatureEngine engine) =>
        Assert.False(new PanoProvisionState(engine, Cli: false, Models: true, Ort: true).IsReady);
}
