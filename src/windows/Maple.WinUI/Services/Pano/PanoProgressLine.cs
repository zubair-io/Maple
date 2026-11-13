using System;
using System.Text.RegularExpressions;

namespace Maple.WinUI.Services.Pano;

/// <summary>One `pano: progress &lt;stage&gt; &lt;label&gt; &lt;percent&gt;%`
/// line from maple-cli (#4578). Stages are the pipeline's 0–5. The bar stays
/// indeterminate until a stage reports a fraction strictly between 0 and
/// 100%: a binary that only marks a stage's start and end, or a stage's first
/// moments, would otherwise show a bar that does not move.</summary>
public sealed record PanoStageProgress(int Stage, string Label, int Percent)
{
    public const int StageCount = 6;

    public bool HasPartialFraction => Percent is > 0 and < 100;

    public string Description => $"{StageName} — step {Stage + 1} of {StageCount}";

    private string StageName => Label switch
    {
        "decode" => "Decoding frames",
        "features" => "Finding features",
        "match_graph" => "Matching frames",
        "refine" => "Refining matches",
        "solve" => "Solving alignment",
        "composite" => "Blending",
        _ => Label,
    };
}

public static partial class PanoProgressLine
{
    [GeneratedRegex(@"^pano: progress (\d+) (\w+) (\d{1,3})%$")]
    private static partial Regex ProgressPattern();

    [GeneratedRegex(@"^pano: alignment — (\w+)")]
    private static partial Regex AlignmentPattern();

    public static PanoStageProgress? TryParse(string line)
    {
        var match = ProgressPattern().Match(line);
        return match.Success
            ? new PanoStageProgress(
                int.Parse(match.Groups[1].Value),
                match.Groups[2].Value,
                Math.Min(100, int.Parse(match.Groups[3].Value)))
            : null;
    }

    /// <summary>`solved`, `reused` or `stale` from the CLI's alignment log
    /// line; null for any other line.</summary>
    public static string? AlignmentStatus(string line)
    {
        var match = AlignmentPattern().Match(line);
        return match.Success ? match.Groups[1].Value : null;
    }

    /// <summary>The status text for a CLI line: a readable stage for a
    /// progress line, the line itself otherwise.</summary>
    public static string Describe(string line) =>
        TryParse(line) is { } progress ? progress.Description : line;
}
