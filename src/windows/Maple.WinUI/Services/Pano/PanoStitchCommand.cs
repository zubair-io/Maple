using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.Services.Pano;

/// <summary>The `maple-cli pano stitch` invocation for one stitch. The ML
/// runtime locations are passed only when the ML engine runs, so a
/// classical stitch never depends on anything provisioned.</summary>
public sealed record PanoStitchCommand(
    IReadOnlyList<string> Arguments, IReadOnlyDictionary<string, string> Environment)
{
    public static PanoStitchCommand Build(
        IReadOnlyList<string> inputs, string outPath, string displayPath,
        string retention, string localAlign, string strategy,
        PanoFeatureEngine engine, string modelsDir, string ortDylibPath)
    {
        var options = new[]
        {
            "pano", "stitch",
            "--out", outPath,
            "--display", displayPath,
            "--retention", retention,
            "--local-align", localAlign,
            "--strategy", strategy,
            "--features-engine", engine.CliValue(),
        };
        var mlRuntime = engine == PanoFeatureEngine.Ml
            ? new[] { "--models-dir", modelsDir }
            : System.Array.Empty<string>();
        // POSIX terminator before the frame paths: a file literally named
        // "--strategy" must never parse as a flag.
        var arguments = options.Concat(mlRuntime).Append("--").Concat(inputs).ToList();
        var environment = engine == PanoFeatureEngine.Ml
            ? new Dictionary<string, string>
            {
                ["MAPLE_PANO_MODELS"] = modelsDir,
                ["ORT_DYLIB_PATH"] = ortDylibPath,
            }
            : new Dictionary<string, string>();
        return new PanoStitchCommand(arguments, environment);
    }
}
