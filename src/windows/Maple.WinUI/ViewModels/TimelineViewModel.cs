using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Maple.WinUI.ViewModels
{
    /// <summary>One node of the sidebar timeline tree: a month with its days as
    /// children, or a leaf day. Invoking a node filters the grid to its period
    /// [PeriodStart, PeriodEndExclusive).</summary>
    public sealed class TimelineNode
    {
        public string Label { get; init; } = string.Empty;
        public int PhotoCount { get; init; }
        public DateTime PeriodStart { get; init; }
        public DateTime PeriodEndExclusive { get; init; }
        public bool IsMonth { get; init; }
        public ObservableCollection<TimelineNode> Children { get; } = new();
    }

    /// <summary>Sidebar timeline (#2570): capture dates grouped month → day,
    /// newest first, keyed on EXIF capture date with file mtime fallback.</summary>
    public partial class TimelineViewModel : ObservableObject
    {
        public ObservableCollection<TimelineNode> Nodes { get; } = new();

        public void GroupPhotosByDate(IEnumerable<PhotoItem> photos)
        {
            var months = photos
                .GroupBy(p => CaptureDay(p) is var d ? new DateTime(d.Year, d.Month, 1) : default)
                .OrderByDescending(g => g.Key)
                .Select(monthGroup =>
                {
                    var node = new TimelineNode
                    {
                        Label = monthGroup.Key.ToString("MMMM yyyy"),
                        PhotoCount = monthGroup.Count(),
                        PeriodStart = monthGroup.Key,
                        PeriodEndExclusive = monthGroup.Key.AddMonths(1),
                        IsMonth = true,
                    };
                    var days = monthGroup
                        .GroupBy(p => CaptureDay(p))
                        .OrderByDescending(g => g.Key)
                        .Select(dayGroup => new TimelineNode
                        {
                            Label = dayGroup.Key.ToString("MMM d — dddd"),
                            PhotoCount = dayGroup.Count(),
                            PeriodStart = dayGroup.Key,
                            PeriodEndExclusive = dayGroup.Key.AddDays(1),
                        });
                    foreach (var day in days)
                        node.Children.Add(day);
                    return node;
                })
                .ToList();

            Nodes.Clear();
            foreach (var month in months)
                Nodes.Add(month);
        }

        public static DateTime CaptureDay(PhotoItem p) =>
            (p.CaptureDate ?? p.FileModifiedUtc.ToLocalTime()).Date;
    }
}
