using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Info Panel organism (unified-component-catalog.md §4.3,
    /// "Info Panel" row: "Full asset metadata", built from Label-Value
    /// Grid, Histogram, Keyword Row, Rating &amp; Flags, Inline Rename
    /// Field) — the read/light-edit metadata tab of the Inspector Panel:
    /// filename (rename-in-place), rating/flag, the live RGB histogram,
    /// EXIF as a Label-Value Grid, and keywords.
    /// </summary>
    public sealed class MuiInfoPanel : ContentControl
    {
        public static readonly DependencyProperty FilenameProperty =
            DependencyProperty.Register(nameof(Filename), typeof(string), typeof(MuiInfoPanel),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiInfoPanel)d).Rebuild()));

        public static readonly DependencyProperty RatingProperty =
            DependencyProperty.Register(nameof(Rating), typeof(int), typeof(MuiInfoPanel),
                new PropertyMetadata(0, (d, e) => ((MuiInfoPanel)d)._ratingFlags.Rating = (int)e.NewValue));

        public static readonly DependencyProperty FlagProperty =
            DependencyProperty.Register(nameof(Flag), typeof(MuiRatingFlagState), typeof(MuiInfoPanel),
                new PropertyMetadata(MuiRatingFlagState.None, (d, e) => ((MuiInfoPanel)d)._ratingFlags.Flag = (MuiRatingFlagState)e.NewValue));

        public static readonly DependencyProperty RedValuesProperty =
            DependencyProperty.Register(nameof(RedValues), typeof(IReadOnlyList<double>), typeof(MuiInfoPanel),
                new PropertyMetadata(null, (d, e) => ((MuiInfoPanel)d)._histogram.RedValues = (IReadOnlyList<double>?)e.NewValue));

        public static readonly DependencyProperty GreenValuesProperty =
            DependencyProperty.Register(nameof(GreenValues), typeof(IReadOnlyList<double>), typeof(MuiInfoPanel),
                new PropertyMetadata(null, (d, e) => ((MuiInfoPanel)d)._histogram.GreenValues = (IReadOnlyList<double>?)e.NewValue));

        public static readonly DependencyProperty BlueValuesProperty =
            DependencyProperty.Register(nameof(BlueValues), typeof(IReadOnlyList<double>), typeof(MuiInfoPanel),
                new PropertyMetadata(null, (d, e) => ((MuiInfoPanel)d)._histogram.BlueValues = (IReadOnlyList<double>?)e.NewValue));

        public static readonly DependencyProperty ExifRowsProperty =
            DependencyProperty.Register(nameof(ExifRows), typeof(IReadOnlyList<MuiLabelValueRow>), typeof(MuiInfoPanel),
                new PropertyMetadata(null, (d, e) => ((MuiInfoPanel)d)._exifGrid.Rows = (IReadOnlyList<MuiLabelValueRow>?)e.NewValue));

        public static readonly DependencyProperty KeywordsProperty =
            DependencyProperty.Register(nameof(Keywords), typeof(IReadOnlyList<MuiChip>), typeof(MuiInfoPanel),
                new PropertyMetadata(null, (d, e) => ((MuiInfoPanel)d)._keywordRow.Keywords = (IReadOnlyList<MuiChip>?)e.NewValue));

        public string Filename { get => (string)GetValue(FilenameProperty); set => SetValue(FilenameProperty, value); }
        public int Rating { get => (int)GetValue(RatingProperty); set => SetValue(RatingProperty, value); }
        public MuiRatingFlagState Flag { get => (MuiRatingFlagState)GetValue(FlagProperty); set => SetValue(FlagProperty, value); }
        public IReadOnlyList<double>? RedValues { get => (IReadOnlyList<double>?)GetValue(RedValuesProperty); set => SetValue(RedValuesProperty, value); }
        public IReadOnlyList<double>? GreenValues { get => (IReadOnlyList<double>?)GetValue(GreenValuesProperty); set => SetValue(GreenValuesProperty, value); }
        public IReadOnlyList<double>? BlueValues { get => (IReadOnlyList<double>?)GetValue(BlueValuesProperty); set => SetValue(BlueValuesProperty, value); }
        public IReadOnlyList<MuiLabelValueRow>? ExifRows { get => (IReadOnlyList<MuiLabelValueRow>?)GetValue(ExifRowsProperty); set => SetValue(ExifRowsProperty, value); }
        public IReadOnlyList<MuiChip>? Keywords { get => (IReadOnlyList<MuiChip>?)GetValue(KeywordsProperty); set => SetValue(KeywordsProperty, value); }

        public event EventHandler<string>? Renamed;
        public event EventHandler<int>? RatingChanged;
        public event EventHandler<MuiRatingFlagState>? FlagChanged;
        public event EventHandler<string>? KeywordRemoved;
        public event EventHandler<string>? KeywordAdded;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 20 };
        private readonly MuiInlineRenameField _renameField = new();
        private readonly MuiRatingFlags _ratingFlags = new();
        private readonly MuiHistogram _histogram = new() { PlotWidth = 260, PlotHeight = 90 };
        private readonly MuiLabelValueGrid _exifGrid = new();
        private readonly MuiKeywordRow _keywordRow = new() { AddPlaceholder = "Add keyword" };

        public MuiInfoPanel()
        {
            var header = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
            header.Children.Add(_renameField);
            header.Children.Add(_ratingFlags);

            _root.Children.Add(header);
            _root.Children.Add(SectionLabel("Histogram"));
            _root.Children.Add(_histogram);
            _root.Children.Add(SectionLabel("Metadata"));
            _root.Children.Add(_exifGrid);
            _root.Children.Add(SectionLabel("Keywords"));
            _root.Children.Add(_keywordRow);
            Content = _root;

            _renameField.Renamed += (_, name) => { Filename = name; Renamed?.Invoke(this, name); };
            _ratingFlags.RatingChanged += (_, value) => { Rating = value; RatingChanged?.Invoke(this, value); };
            _ratingFlags.FlagChanged += (_, value) => { Flag = value; FlagChanged?.Invoke(this, value); };
            _keywordRow.Removed += (_, id) => KeywordRemoved?.Invoke(this, id);
            _keywordRow.Added += (_, label) => KeywordAdded?.Invoke(this, label);

            Rebuild();
        }

        private static MuiText SectionLabel(string text) => new() { Text = text, Variant = MuiTextVariant.Eyebrow, ColorRole = MuiTextColorRole.Muted };

        private void Rebuild()
        {
            _renameField.Value = Filename;
            _renameField.AccessibleLabel = $"Rename {Filename}";
        }
    }
}
