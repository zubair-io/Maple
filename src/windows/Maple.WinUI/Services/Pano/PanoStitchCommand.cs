using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.Services.Pano;

/// <summary>The seam regions one stitch carries (#5992): the request, the
/// file it is handed to maple-cli in, and the report the run answers in.</summary>
public sealed record PanoSeamStitch(PanoSeamRequest Request, string ConstraintsJson, string ReportJson);

/// <summary>The `maple-cli pano stitch` invocation for one stitch. The ML
/// runtime locations are passed only when the ML engine runs, so a
/// classical stitch never depends on anything provisioned. `alignmentIn` is
/// a preview's solved alignment to start from (#4581); the preview ran with
/// the same engine, which the alignment key also covers.</summary>
public sealed record PanoStitchCommand(
    IReadOnlyList<string> Arguments, IReadOnlyDictionary<string, string> Environment)
{
    public static PanoStitchCommand Build(
        IReadOnlyList<string> inputs, string outPath, string displayPath,
        string retention, string localAlign, string strategy, string? alignmentIn,
        PanoFeatureEngine engine, string modelsDir, string ortDylibPath,
        PanoSeamStitch? seams = null)
    {
        var options = new[]
        {
            "pano", "stitch",
            "--out", outPath,
            "--display", displayPath,
            "--retention", retention,
            "--local-align", localAlign,
            "--strategy", strategy,
        };
        var seamArguments = seams is null
            ? Enumerable.Empty<string>()
            : new[] { "--report", seams.ReportJson }.Concat(PanoPreviewCommand.SeamConstraints(seams.ConstraintsJson));
        // POSIX terminator before the frame paths: a file literally named
        // "--strategy" must never parse as a flag.
        var arguments = options
            .Concat(engine.CliArguments(modelsDir))
            .Concat(seamArguments)
            .Concat(PanoPreviewCommand.AlignmentIn(alignmentIn))
            .Append("--")
            .Concat(inputs)
            .ToList();
        return new PanoStitchCommand(arguments, engine.CliEnvironment(modelsDir, ortDylibPath));
    }
}
