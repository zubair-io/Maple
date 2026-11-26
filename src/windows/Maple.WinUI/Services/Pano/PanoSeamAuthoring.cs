using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Maple.WinUI.Services.Pano;

public sealed record PanoSeamVerdict(string? Message, bool PreviewAgain);

/// <summary>The stitch dialog's seam regions and when they may be edited
/// (#5992), following the Web and Apple surfaces. Regions are drawn against
/// one preview's uncropped canvas and are only valid for that geometry:
/// changing an option or the frames drops them, a preview that is pending or
/// failed keeps authoring closed, and a preview that had to re-solve its
/// alignment while carrying regions is refused by name. UI-thread only.</summary>
public sealed class PanoSeamAuthoring
{
    public const string TileReason =
        "Seam regions are not supported for Tile. Choose Rotation, or Auto for a rotation panorama.";
    public const string FramesNotListedReason =
        "Seam regions are unavailable: the preview did not list its frames, so their numbers cannot be trusted.";
    public const string WaitReason = "Wait for a current preview before authoring or submitting seam regions.";
    public const string StaleGeometry =
        PanoCliReport.InvalidSeamConstraints + ": preview geometry changed; repaint the regions.";
    public const string InvalidRegion =
        "Choose a frame and a positive whole-pixel rectangle wholly inside the preview canvas.";
    public const string InvalidNumbers = "Enter X, Y, width and height as whole preview pixels.";

    private static readonly IReadOnlyList<PanoSeamRegion> NoRegions = Array.Empty<PanoSeamRegion>();

    private IReadOnlyList<PanoSeamRegion> _regions = NoRegions;
    private PanoSeamCanvas? _preview;
    private PanoSeamCanvas? _reference;
    private IReadOnlyList<string> _frames = Array.Empty<string>();
    private bool _pending;
    private bool _resolvedTile;
    private string _strategy = "auto";

    public event Action? Changed;

    /// <summary>The frames in the order the CLI numbers them, as its preview
    /// report listed them; empty until a preview has.</summary>
    public IReadOnlyList<string> Frames => _frames;

    public IReadOnlyList<PanoSeamRegion> Regions => _regions;

    /// <summary>The canvas the regions are measured in: the one they were
    /// drawn on while any exist, otherwise the current preview's.</summary>
    public PanoSeamCanvas? Canvas => _regions.Count > 0 ? _reference : _preview;

    public string? DisabledReason =>
        _strategy == "tile" || _resolvedTile ? TileReason
        : _pending || _preview is null ? WaitReason
        : _frames.Count == 0 ? FramesNotListedReason
        : null;

    public bool CanAuthor => DisabledReason is null;

    public bool CanSubmit => _regions.Count == 0 || CanAuthor;

    /// <summary>Remove and Clear are held while a preview is running: its
    /// answer would otherwise arrive for regions that are gone.</summary>
    public bool CanChangeRegions => !_pending;

    public PanoSeamRequest? Request =>
        _regions.Count > 0 && _reference is { } canvas ? new PanoSeamRequest(canvas, _regions) : null;

    public void GeometryChanged(string strategy)
    {
        _strategy = strategy;
        _resolvedTile = false;
        DropGeometry();
        Changed?.Invoke();
    }

    public void PreviewRequested()
    {
        _pending = true;
        Changed?.Invoke();
    }

    public PanoSeamVerdict PreviewCompleted(PanoPreviewCompletion completion, bool isLatest)
    {
        if (!isLatest)
            return new PanoSeamVerdict(null, false);
        _pending = false;
        var verdict = Adopt(completion);
        Changed?.Invoke();
        return verdict;
    }

    public string? Add(PanoSeamKind kind, int frame, PanoSeamRect rect)
    {
        if (DisabledReason is { } reason)
            return reason;
        if (Canvas is not { } canvas || frame < 0 || frame >= Frames.Count
            || !PanoSeamGeometry.Contains(canvas, rect))
            return InvalidRegion;
        _reference = canvas;
        _regions = _regions.Append(new PanoSeamRegion(kind, frame, rect)).ToList();
        Changed?.Invoke();
        return null;
    }

    public string? AddFromText(PanoSeamKind kind, int frame, string x, string y, string width, string height)
    {
        var values = new[] { x, y, width, height }.Select(Whole).OfType<int>().ToArray();
        return values.Length == 4
            ? Add(kind, frame, new PanoSeamRect(values[0], values[1], values[2], values[3]))
            : InvalidNumbers;
    }

    public void Remove(int index)
    {
        if (!CanChangeRegions || index < 0 || index >= _regions.Count)
            return;
        SetRegions(_regions.Where((_, at) => at != index).ToList());
    }

    public void Clear()
    {
        if (CanChangeRegions)
            SetRegions(NoRegions);
    }

    private PanoSeamVerdict Adopt(PanoPreviewCompletion completion)
    {
        var seams = completion.Run.Seams;
        if (!completion.Outcome.Ok || completion.Outcome.Report is not { } report)
            return new PanoSeamVerdict(seams is null ? null : completion.Outcome.Error ?? "preview failed", false);
        if (seams is not null && (report.AlignmentStatus == "stale" || report.Canvas != seams.Canvas))
        {
            DropGeometry();
            return new PanoSeamVerdict(StaleGeometry, true);
        }
        _preview = report.Canvas;
        _resolvedTile = report.Strategy == "tile";
        _frames = report.Inputs ?? Array.Empty<string>();
        return new PanoSeamVerdict(null, false);
    }

    private void DropGeometry()
    {
        _regions = NoRegions;
        _reference = null;
        _preview = null;
    }

    private void SetRegions(IReadOnlyList<PanoSeamRegion> regions)
    {
        _regions = regions;
        if (regions.Count == 0)
            _reference = null;
        Changed?.Invoke();
    }

    private static int? Whole(string text) =>
        int.TryParse(text.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var value) ? value : null;
}
