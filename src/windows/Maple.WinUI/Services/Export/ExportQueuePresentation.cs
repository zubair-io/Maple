using System;
using System.Linq;

namespace Maple.WinUI.Services.Export;

public sealed record ExportQueueListing(string Id, DateTimeOffset CreatedAt, string RecipeName, int Total);

/// <summary>Immutable UI progress; never copies frozen XMP documents into dispatcher callbacks.</summary>
public sealed record ExportQueuePresentation(string Summary, string Details, int Remaining, int Failed)
{
    public static ExportQueuePresentation Capture(ExportQueueJob job)
    {
        var applied = job.Entries.Count(i => i.Status == "applied");
        var skipped = job.Entries.Count(i => i.Status == "skipped");
        var failed = job.Entries.Count(i => i.Status == "failed");
        var remaining = job.Entries.Count - applied - skipped - failed;
        return new(
            $"{applied} exported · {skipped} skipped · {failed} failed · {remaining} remaining"
                + (job.Cancelled ? " · cancelled" : ""),
            string.Join("\n\n", job.Entries.Select(i =>
                $"{i.SequenceIndex + 1}. {i.Input.OriginalStem} — {i.Status}\n{i.OutputPath}"
                + (i.Reason == null ? "" : $"\n{i.Reason}"))),
            remaining, failed);
    }
}
