using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Maple.WinUI.ViewModels
{
    public class TimelineGroup
    {
        public string DateLabel { get; set; } = string.Empty;
        public int PhotoCount { get; set; }
        public ObservableCollection<PhotoItem> Items { get; } = new();
    }

    public partial class TimelineViewModel : ObservableObject
    {
        public ObservableCollection<TimelineGroup> DateGroups { get; } = new();

        public void GroupPhotosByDate(IEnumerable<PhotoItem> photos)
        {
            DateGroups.Clear();

            var groups = photos.GroupBy(p =>
            {
                if (DateTime.TryParse(p.DateTaken, out var dt))
                {
                    return dt.ToString("yyyy-MM-dd (dddd)");
                }
                return "Unknown Date";
            }).OrderByDescending(g => g.Key);

            foreach (var group in groups)
            {
                var tg = new TimelineGroup
                {
                    DateLabel = group.Key,
                    PhotoCount = group.Count()
                };
                foreach (var item in group)
                {
                    tg.Items.Add(item);
                }
                DateGroups.Add(tg);
            }
        }
    }
}
