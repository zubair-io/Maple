using System;
using System.IO;
using System.Text.Json;

namespace Maple.WinUI.Services.Pano;

public sealed record PanoPreviewReport(
    PanoSeamCanvas Canvas, string Strategy, string AlignmentStatus, PanoSeamRequest? SeamConstraints);

/// <summary>A run maple-cli refused by name (#5992). The text is shown to
/// the user as it is, led by the refusal's name.</summary>
public sealed record PanoCliRefusal(string Name, string Message)
{
    public string Text => Message.StartsWith(Name, StringComparison.Ordinal) ? Message : $"{Name}: {Message}";
}

/// <summary>Reads the JSON `maple-cli pano stitch --report` writes: the
/// preview's uncropped canvas and alignment verdict, the seam request it
/// echoes, and a `refused` block when it declined to run.</summary>
public static class PanoCliReport
{
    public const string InvalidSeamConstraints = "invalid_seam_constraints";

    public static PanoCliRefusal? Refusal(string json) =>
        Root(json) is { } root
        && root.TryGetProperty("refused", out var refused) && refused.ValueKind == JsonValueKind.Object
        && Text(refused, "resource") == "seam_constraints"
        && Text(refused, "message") is { } message
            ? new PanoCliRefusal(InvalidSeamConstraints, message)
            : null;

    public static PanoPreviewReport? Preview(string json)
    {
        if (Root(json) is not { } root
            || Whole(root, "width") is not { } width || Whole(root, "height") is not { } height
            || Text(root, "strategy") is not { } strategy
            || !root.TryGetProperty("alignment", out var alignment) || alignment.ValueKind != JsonValueKind.Object
            || Text(alignment, "status") is not { } status)
            return null;
        return new PanoPreviewReport(new PanoSeamCanvas(width, height), strategy, status, SeamEcho(root));
    }

    public static PanoSeamRequest? SeamEcho(string json) => Root(json) is { } root ? SeamEcho(root) : null;

    /// <summary>The report's text; null when the run wrote none.</summary>
    public static string? Read(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Why a run failed: the named refusal from its report when
    /// there is one, otherwise the exit code and the stderr tail.</summary>
    public static string Failure(PanoCliExit exit, string? reportPath) =>
        (reportPath is null ? null : Read(reportPath)) is { } json && Refusal(json) is { } refusal
            ? refusal.Text
            : $"maple-cli exited {exit.ExitCode}:\n{exit.StderrTail}";

    private static PanoSeamRequest? SeamEcho(JsonElement root) =>
        root.TryGetProperty("seam_constraints", out var echo) ? PanoSeamRequest.Parse(echo) : null;

    private static JsonElement? Root(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            return document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement.Clone() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? Text(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? Whole(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
        && value.TryGetInt32(out var whole) && whole > 0
            ? whole
            : null;
}
