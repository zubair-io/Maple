using Maple.WinUI.Generated;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

/// <summary>What an Auto Profile fit achieved for one decode (#5458),
/// classified from the native fit's return code — never inferred from the
/// file type.</summary>
public enum AutoProfileOutcome { Applied, NoPreview, Unavailable }

public static class AutoProfileStatus
{
    public const string AppliedText = "Color and contrast matched to this image’s embedded camera preview.";
    public const string NoPreviewText = "Auto unavailable: no camera preview — showing Neutral.";
    public const string UnavailableText = "Auto matching is unavailable for this image; camera-preview matching was not applied.";

    public static AutoProfileOutcome Classify(int fitReturnCode) => fitReturnCode switch
    {
        0 => AutoProfileOutcome.Applied,
        AutoFitCodes.NoPreview => AutoProfileOutcome.NoPreview,
        _ => AutoProfileOutcome.Unavailable,
    };

    public static string Describe(ProfileMode profile, AutoProfileOutcome? outcome) =>
        profile != ProfileMode.Auto ? string.Empty : outcome switch
        {
            AutoProfileOutcome.Applied => AppliedText,
            AutoProfileOutcome.NoPreview => NoPreviewText,
            AutoProfileOutcome.Unavailable => UnavailableText,
            _ => string.Empty,
        };

    /// <summary>The panel shows a visible line only for the Neutral fallback;
    /// the other outcomes stay in the picker's accessible help text.</summary>
    public static string VisibleLine(ProfileMode profile, AutoProfileOutcome? outcome) =>
        outcome == AutoProfileOutcome.NoPreview ? Describe(profile, outcome) : string.Empty;
}

/// <summary>The session's achieved-fit status, owned by one decode
/// generation: a result from any other generation (an older photo, profile
/// or decode-owned edit) leaves the current status untouched.</summary>
public readonly record struct AutoProfileStatusState(int Generation, AutoProfileOutcome? Outcome)
{
    public AutoProfileStatusState Begin(int generation, bool keepOutcome) =>
        new(generation, keepOutcome ? Outcome : null);

    public AutoProfileStatusState Publish(int generation, AutoProfileOutcome? outcome) =>
        generation == Generation ? this with { Outcome = outcome } : this;
}
