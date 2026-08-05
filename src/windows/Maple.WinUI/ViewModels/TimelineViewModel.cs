using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Maple.WinUI.ViewModels
{
    public sealed class TimelineGroup
    {
        public string DateLabel { get; init; } = string.Empty;
        public int PhotoCount { get; init; }
        public DateTime SortKey { get; init; }
        public ObservableCollection<PhotoItem> Items { get; } = new();
    }

    /// <summary>Date grouping for the sidebar timeline, keyed on EXIF capture
    /// date with file mtime as the fallback.</summary>
    public partial class TimelineViewModel : ObservableObject
    {
        public ObservableCollection<TimelineGroup> DateGroups { get; } = new();

        public void GroupPhotosByDate(IEnumerable<PhotoItem> photos)
        {
            var groups = photos
                .GroupBy(p => (p.CaptureDate ?? p.FileModifiedUtc.ToLocalTime()).Date)
                .OrderByDescending(g => g.Key)
                .Select(g =>
                {
                    var tg = new TimelineGroup
                    {
                        DateLabel = g.Key.ToString("yyyy-MM-dd (dddd)"),
                        PhotoCount = g.Count(),
                        SortKey = g.Key,
                    };
                    foreach (var item in g)
                        tg.Items.Add(item);
                    return tg;
                })
                .ToList();

            DateGroups.Clear();
            foreach (var group in groups)
                DateGroups.Add(group);
        }
    }
}
