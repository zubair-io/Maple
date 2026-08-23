using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One line of a transcript.</summary>
    public sealed record MuiTranscriptEntry(string Id, double OffsetMs, string? Speaker, string Text);

    /// <summary>
    /// Maple.UI Transcript Block molecule (unified-component-catalog.md
    /// §3, "Transcript Block" row: "Timestamped read-only transcript",
    /// built from Text, Timestamp) — each entry's time code is expressed
    /// as an offset (ms) from <see cref="BaseTime"/>, rendered through the
    /// real <see cref="MuiTimestamp"/> atom (TimeOnly format) rather than a
    /// hand-rolled mm:ss formatter, matching
    /// `mui-transcript-block.component.ts`'s own "genuine composition, not
    /// a lookalike" note.
    /// </summary>
    public sealed class MuiTranscriptBlock : ContentControl
    {
        public static readonly DependencyProperty BaseTimeProperty =
            DependencyProperty.Register(nameof(BaseTime), typeof(DateTimeOffset), typeof(MuiTranscriptBlock),
                new PropertyMetadata(default(DateTimeOffset), (d, _) => ((MuiTranscriptBlock)d).Rebuild()));

        public static readonly DependencyProperty EntriesProperty =
            DependencyProperty.Register(nameof(Entries), typeof(IReadOnlyList<MuiTranscriptEntry>), typeof(MuiTranscriptBlock),
                new PropertyMetadata(null, (d, _) => ((MuiTranscriptBlock)d).Rebuild()));

        public DateTimeOffset BaseTime
        {
            get => (DateTimeOffset)GetValue(BaseTimeProperty);
            set => SetValue(BaseTimeProperty, value);
        }

        public IReadOnlyList<MuiTranscriptEntry>? Entries
        {
            get => (IReadOnlyList<MuiTranscriptEntry>?)GetValue(EntriesProperty);
            set => SetValue(EntriesProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 8 };

        public MuiTranscriptBlock()
        {
            Content = _root;
            IsTabStop = false;
            Rebuild();
        }

        private void Rebuild()
        {
            _root.Children.Clear();
            foreach (var entry in Entries ?? Array.Empty<MuiTranscriptEntry>())
                _root.Children.Add(BuildRow(entry));
        }

        private UIElement BuildRow(MuiTranscriptEntry entry)
        {
            var row = new Grid { ColumnSpacing = 12 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var time = new MuiTimestamp
            {
                Value = BaseTime.AddMilliseconds(entry.OffsetMs),
                Format = MuiTimestampFormat.TimeOnly,
            };
            Grid.SetColumn(time, 0);

            var line = new StackPanel { Orientation = Orientation.Vertical, Spacing = 2 };
            if (!string.IsNullOrEmpty(entry.Speaker))
                line.Children.Add(new MuiText { Text = entry.Speaker!, Variant = MuiTextVariant.ChipLabel, ColorRole = MuiTextColorRole.Muted });
            line.Children.Add(new MuiText { Text = entry.Text, Variant = MuiTextVariant.Body });
            Grid.SetColumn(line, 1);

            row.Children.Add(time);
            row.Children.Add(line);
            return row;
        }
    }
}
