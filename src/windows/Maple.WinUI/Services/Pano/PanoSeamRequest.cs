using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace Maple.WinUI.Services.Pano;

public enum PanoSeamKind
{
    Include,
    Exclude,
}

public readonly record struct PanoSeamCanvas(int Width, int Height);

public readonly record struct PanoSeamRect(int X, int Y, int Width, int Height);

public sealed record PanoSeamRegion(PanoSeamKind Kind, int Frame, PanoSeamRect Rect);

/// <summary>SeamConstraintsRequest v1 (#5992; docs/pano.md § User-constrained
/// seam requests), the file `maple-cli pano stitch --seam-constraints` reads.
/// `Frame` indexes the inputs in the order maple-cli sorts them, which its
/// preview report lists. Validation and the mapping from this
/// reference canvas onto the output stay in the shared Rust core.</summary>
public sealed record PanoSeamRequest(PanoSeamCanvas Canvas, IReadOnlyList<PanoSeamRegion> Regions)
{
    public const int Version = 1;

    public string ToJson()
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteNumber("version", Version);
            json.WriteStartObject("canvas");
            json.WriteNumber("width", Canvas.Width);
            json.WriteNumber("height", Canvas.Height);
            json.WriteEndObject();
            json.WriteStartArray("regions");
            foreach (var region in Regions)
            {
                json.WriteStartObject();
                json.WriteString("kind", KindName(region.Kind));
                json.WriteNumber("frame", region.Frame);
                json.WriteNumber("x", region.Rect.X);
                json.WriteNumber("y", region.Rect.Y);
                json.WriteNumber("width", region.Rect.Width);
                json.WriteNumber("height", region.Rect.Height);
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>The request a maple-cli report echoes as `seam_constraints`;
    /// null for JSON null, another version, or any other shape.</summary>
    public static PanoSeamRequest? Parse(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
            return null;
        try
        {
            if (element.GetProperty("version").GetInt32() != Version)
                return null;
            var canvas = element.GetProperty("canvas");
            var regions = element.GetProperty("regions").EnumerateArray().Select(ParseRegion).ToList();
            return new PanoSeamRequest(
                new PanoSeamCanvas(canvas.GetProperty("width").GetInt32(), canvas.GetProperty("height").GetInt32()),
                regions);
        }
        catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    public bool Matches(PanoSeamRequest? other) =>
        other is not null && Canvas == other.Canvas && Regions.SequenceEqual(other.Regions);

    private static string KindName(PanoSeamKind kind) => kind == PanoSeamKind.Include ? "include" : "exclude";

    private static PanoSeamRegion ParseRegion(JsonElement region) => new(
        region.GetProperty("kind").GetString() switch
        {
            "include" => PanoSeamKind.Include,
            "exclude" => PanoSeamKind.Exclude,
            var other => throw new FormatException($"unknown seam region kind {other}"),
        },
        region.GetProperty("frame").GetInt32(),
        new PanoSeamRect(
            region.GetProperty("x").GetInt32(), region.GetProperty("y").GetInt32(),
            region.GetProperty("width").GetInt32(), region.GetProperty("height").GetInt32()));
}
