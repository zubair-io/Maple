using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.Services.Pano;

/// <summary>Automation ids of the seam editor's controls, which tests and
/// the lifecycle smoke look up by instead of by name: a ComboBox's inner
/// text box can carry the same accessible name as the ComboBox.</summary>
public static class PanoSeamIds
{
    public const string Frame = "pano-seam-frame";
    public const string Kind = "pano-seam-kind";
    public const string X = "pano-seam-x";
    public const string Y = "pano-seam-y";
    public const string Width = "pano-seam-width";
    public const string Height = "pano-seam-height";
    public const string Add = "pano-seam-add";
    public const string Clear = "pano-seam-clear";
    public const string Preview = "pano-seam-preview";
    public const string List = "pano-seam-regions";

    public static string Remove(int index) => $"pano-seam-remove-{index}";
}

/// <summary>The seam editor's wording (#5992), shared with the Web and
/// Apple editors where the platform allows.</summary>
public static class PanoSeamText
{
    public const string ListName = "Authored seam regions";
    public const string Include = "Include — use this frame";
    public const string Exclude = "Exclude — avoid this frame";

    public static string Guide(PanoSeamCanvas? canvas) =>
        "Choose a source frame, then drag a rectangle on the preview or enter coordinates below. "
        + "Include uses that frame; Exclude avoids it. "
        + (canvas is { } size ? $"Reference canvas: {size.Width} × {size.Height} preview pixels. " : string.Empty)
        + "Regions use graph-cut seams. Auto may choose a tile mosaic, which refuses regions; "
        + "choose Rotation in that case. Changing an option clears regions.";

    public static IReadOnlyList<string> FrameLabels(IReadOnlyList<string> frames)
    {
        var oneFolder = frames.Select(Folder).Distinct().Count() <= 1;
        return frames.Select((path, index) => $"{index + 1}: {(oneFolder ? Name(path) : path)}").ToList();
    }

    public static string Region(int index, PanoSeamRegion region) =>
        $"{index + 1}. {(region.Kind == PanoSeamKind.Include ? "Include" : "Exclude")} frame {region.Frame + 1}: "
        + $"X {region.Rect.X}, Y {region.Rect.Y}, {region.Rect.Width} × {region.Rect.Height}";

    public static string Badge(int index, PanoSeamRegion region) =>
        $"{index + 1} {(region.Kind == PanoSeamKind.Include ? "+" : "−")}";

    public static string Count(int regions) => regions == 1 ? "1 seam region" : $"{regions} seam regions";

    public static string CanvasName(PanoSeamCanvas canvas) =>
        $"Uncropped panorama seam canvas, {canvas.Width} by {canvas.Height} pixels";

    public static string Remove(int index) => $"Remove seam region {index + 1}";

    private static int LastSeparator(string path) => path.LastIndexOfAny(new[] { '\\', '/' });

    private static string Folder(string path) => path[..(LastSeparator(path) + 1)];

    private static string Name(string path) => path[(LastSeparator(path) + 1)..];
}
