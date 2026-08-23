using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One entry in a Notification Feed.</summary>
    public sealed record MuiNotificationEntry(string Id, string IconName, string Message, DateTimeOffset At, bool Unread = false);

    /// <summary>
    /// Maple.UI Notification Feed organism (unified-component-catalog.md
    /// §4.7, "Notification Feed" row: "Filterable activity list", built
    /// from List Row, Chip Row, Empty State) — a category
    /// <see cref="MuiChipRow"/> filters a <see cref="MuiListRow"/> list,
    /// or a <see cref="MuiEmptyState"/> when nothing matches.
    /// </summary>
    public sealed class MuiNotificationFeed : ContentControl
    {
        public static readonly DependencyProperty CategoriesProperty =
            DependencyProperty.Register(nameof(Categories), typeof(IReadOnlyList<MuiChip>), typeof(MuiNotificationFeed),
                new PropertyMetadata(null, (d, e) => ((MuiNotificationFeed)d)._categoryChips.Chips = (IReadOnlyList<MuiChip>?)e.NewValue));

        public static readonly DependencyProperty SelectedCategoryIdProperty =
            DependencyProperty.Register(nameof(SelectedCategoryId), typeof(string), typeof(MuiNotificationFeed),
                new PropertyMetadata(null, (d, e) => ((MuiNotificationFeed)d)._categoryChips.SelectedId = (string?)e.NewValue));

        public static readonly DependencyProperty EntriesProperty =
            DependencyProperty.Register(nameof(Entries), typeof(IReadOnlyList<MuiNotificationEntry>), typeof(MuiNotificationFeed),
                new PropertyMetadata(null, (d, _) => ((MuiNotificationFeed)d).Rebuild()));

        public IReadOnlyList<MuiChip>? Categories { get => (IReadOnlyList<MuiChip>?)GetValue(CategoriesProperty); set => SetValue(CategoriesProperty, value); }
        public string? SelectedCategoryId { get => (string?)GetValue(SelectedCategoryIdProperty); set => SetValue(SelectedCategoryIdProperty, value); }

        public IReadOnlyList<MuiNotificationEntry>? Entries
        {
            get => (IReadOnlyList<MuiNotificationEntry>?)GetValue(EntriesProperty);
            set => SetValue(EntriesProperty, value);
        }

        public event EventHandler<string>? CategorySelected;
        public event EventHandler<string>? EntryActivated;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 10 };
        private readonly MuiChipRow _categoryChips = new() { Mode = MuiChipRowMode.Select };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly MuiEmptyState _empty = new() { IconName = "info", Title = "You're all caught up" };

        public MuiNotificationFeed()
        {
            _root.Children.Add(_categoryChips);
            _root.Children.Add(_rows);
            _root.Children.Add(_empty);
            Content = _root;

            _categoryChips.SelectionChanged += (_, id) => { SelectedCategoryId = id; CategorySelected?.Invoke(this, id); };

            Rebuild();
        }

        private void Rebuild()
        {
            var entries = Entries ?? Array.Empty<MuiNotificationEntry>();
            _empty.Visibility = entries.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _rows.Visibility = entries.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _rows.Children.Clear();
            var now = DateTimeOffset.Now;
            foreach (var entry in entries)
            {
                var trailing = new MuiTimestamp { Value = entry.At, Now = now, Format = MuiTimestampFormat.Relative };
                var row = new MuiListRow { Label = entry.Message, IconName = entry.IconName, TrailingContent = trailing, Active = entry.Unread };
                var id = entry.Id;
                row.Pressed += (_, _) => EntryActivated?.Invoke(this, id);
                _rows.Children.Add(row);
            }
        }
    }
}
