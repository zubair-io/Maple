using System.Diagnostics;
using Maple.WinUI.Services.Pano;
using Xunit;

namespace Maple.WinUI.Tests;

/// <summary>Where the native panorama tools are (#5992): `MAPLE_PANO_CLI`
/// names a maple-cli, otherwise the one beside the core CI builds
/// (`MAPLE_RAW_FFI_DLL`). `pano-gen-fixture` sits beside it when the build
/// script made it; `MAPLE_PANO_TEST_RAWS` names a folder of real overlapping
/// frames to use instead.</summary>
internal static class PanoNativeTools
{
    private static readonly TimeSpan GenerationLimit = TimeSpan.FromMinutes(2);

    public static string? CliPath()
    {
        var named = Environment.GetEnvironmentVariable("MAPLE_PANO_CLI");
        var core = Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL");
        return !string.IsNullOrEmpty(named) ? named
            : !string.IsNullOrEmpty(core) ? Path.Combine(Path.GetDirectoryName(core)!, "maple-cli.exe")
            : null;
    }

    public static string? FixtureToolPath() =>
        CliPath() is { } cli
        && Path.Combine(Path.GetDirectoryName(cli)!, OperatingSystem.IsWindows() ? "pano-gen-fixture.exe" : "pano-gen-fixture") is { } tool
        && File.Exists(tool)
            ? tool
            : null;

    public static string? RealFramesFolder()
    {
        var folder = Environment.GetEnvironmentVariable("MAPLE_PANO_TEST_RAWS");
        return string.IsNullOrEmpty(folder) ? null : folder;
    }

    public static PanoCliHost Host(string root)
    {
        var cli = CliPath() ?? throw new InvalidOperationException("no maple-cli is named");
        Assert.True(File.Exists(cli), $"maple-cli is missing: {cli} (build it with --features pano,pano-classical)");
        Directory.CreateDirectory(root);
        return new PanoCliHost(cli, PanoFeatureEngine.Classical, root, root);
    }

    public static PanoPreviewRun PreviewRun(string root, string strategy, PanoSeamRequest? seams, string? alignmentIn)
    {
        var id = Guid.NewGuid().ToString("N");
        var files = new PanoPreviewFiles(Path.Combine(root, $"preview-{id}.png"), Path.Combine(root, $"alignment-{id}.json"));
        return new PanoPreviewRun(new PanoPreviewOptions("keep", "mesh", strategy), files, alignmentIn, seams);
    }

    /// <summary>Overlapping frames: the real ones when `MAPLE_PANO_TEST_RAWS`
    /// names a folder, otherwise a synthetic rotation ring that
    /// `pano-gen-fixture` writes into <paramref name="folder"/>.</summary>
    public static async Task<IReadOnlyList<string>> FramesAsync(string folder)
    {
        if (RealFramesFolder() is { } real)
            return Directory.EnumerateFiles(real).Where(path =>
                Path.GetExtension(path).ToLowerInvariant() is ".dng" or ".cr2" or ".cr3" or ".nef" or ".arw" or ".raf").ToList();

        var tool = FixtureToolPath() ?? throw new InvalidOperationException("pano-gen-fixture is not beside maple-cli");
        var psi = new ProcessStartInfo(tool) { RedirectStandardError = true };
        foreach (var argument in new[]
            { "--out-dir", folder, "--cameras", "3", "--width", "640", "--height", "480", "--source-width", "2048" })
            psi.ArgumentList.Add(argument);
        using var process = Process.Start(psi)!;
        using var limit = new CancellationTokenSource(GenerationLimit);
        var stderr = process.StandardError.ReadToEndAsync(limit.Token);
        await process.WaitForExitAsync(limit.Token);
        Assert.True(process.ExitCode == 0, $"pano-gen-fixture failed: {await stderr}");
        return Directory.EnumerateFiles(folder, "*.dng").ToList();
    }
}

/// <summary>Reported as skipped, not passed, when there is no maple-cli to run.</summary>
public sealed class PanoCliFactAttribute : FactAttribute
{
    public PanoCliFactAttribute()
    {
        if (PanoNativeTools.CliPath() is null)
            Skip = "Neither MAPLE_PANO_CLI nor MAPLE_RAW_FFI_DLL is set; maple-cli was not run.";
    }
}

/// <summary>Skipped unless a maple-cli and overlapping frames are both
/// available: `pano-gen-fixture` beside it, or `MAPLE_PANO_TEST_RAWS`.</summary>
public sealed class PanoFramesFactAttribute : FactAttribute
{
    public PanoFramesFactAttribute()
    {
        if (PanoNativeTools.CliPath() is null)
            Skip = "Neither MAPLE_PANO_CLI nor MAPLE_RAW_FFI_DLL is set; maple-cli was not run.";
        else if (PanoNativeTools.RealFramesFolder() is null && PanoNativeTools.FixtureToolPath() is null)
            Skip = "pano-gen-fixture is not beside maple-cli and MAPLE_PANO_TEST_RAWS is not set; there are no overlapping frames.";
    }
}
