using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.Services.Pano;

public sealed record PanoPreviewOptions(string Retention, string LocalAlign, string Strategy);

/// <summary>The `maple-cli pano stitch --preview-out` invocation (#4581).
/// The previous preview's alignment is offered back: the CLI reuses it when
/// the frames and the geometry options still match, and re-solves (reporting
/// `stale`) when they don't. The engine is the one the stitch will use, so
/// the stitch can start from this alignment.</summary>
public sealed record PanoPreviewCommand(
    IReadOnlyList<string> Arguments, IReadOnlyDictionary<string, string> Environment)
{
    public static PanoPreviewCommand Build(
        IReadOnlyList<string> inputs, PanoPreviewFiles files, string? alignmentIn,
        PanoPreviewOptions options, PanoFeatureEngine engine, string modelsDir, string ortDylibPath)
    {
        var head = new[]
        {
            "pano", "stitch",
            "--preview-out", files.PreviewPng,
            "--alignment-out", files.AlignmentJson,
            "--retention", options.Retention,
            "--local-align", options.LocalAlign,
            "--strategy", options.Strategy,
        };
        // POSIX terminator before the frame paths, as in the full stitch.
        var arguments = head
            .Concat(engine.CliArguments(modelsDir))
            .Concat(AlignmentIn(alignmentIn))
            .Append("--")
            .Concat(inputs)
            .ToList();
        return new PanoPreviewCommand(arguments, engine.CliEnvironment(modelsDir, ortDylibPath));
    }

    /// <summary>`--alignment-in &lt;file&gt;`, or nothing when there is no
    /// alignment to offer.</summary>
    public static IEnumerable<string> AlignmentIn(string? alignmentPath) =>
        alignmentPath is null ? Enumerable.Empty<string>() : new[] { "--alignment-in", alignmentPath };
}
