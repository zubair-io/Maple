using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;

namespace Maple.UI.Atoms
{
    /// <summary>One segment of a MuiSegmentedToggle.</summary>
    public sealed record MuiSegmentedToggleOption(string Label, string? AccessibleLabel = null);

    /// <summary>
    /// Maple.UI Segmented Toggle atom (unified-component-catalog.md §1.3
    /// Form controls, "Segmented Toggle" row: "2-3 exclusive options ·
    /// States per segment · Selection indicator motion") — a pill-style
    /// exclusive-choice control (e.g. Fit/Fill, Grid/List).
    ///
    /// Hand-rolled from plain <see cref="ToggleButton"/>s laid across a
    /// <see cref="Grid"/> with one equal-width column per option, plus a
    /// <see cref="Canvas"/>-positioned pill <see cref="Border"/> underneath
    /// that slides via a simple <see cref="DoubleAnimation"/> on
    /// `(Canvas.Left)` — deliberately the most conservative motion approach
    /// available (no Composition API, no VisualStateManager) since this
    /// wave has no compiler to verify a fancier one against. Segments are
    /// NOT grouped through a native radio-group API: WinUI's `RadioButtons`
    /// control renders default radio-dot chrome (wrong shape for a
    /// segmented pill) and hand-grouping plain `RadioButton`s still leaves
    /// the same template-rewrite problem Button/ActionButton hover states
    /// have. Exclusivity is enforced in code (uncheck-the-rest on click);
    /// each segment still exposes its own native toggle-checked automation
    /// state, just not a single grouped "radiogroup" role — a known gap,
    /// not a missed requirement.
    /// </summary>
    public sealed class MuiSegmentedToggle : ContentControl
    {
        public static readonly DependencyProperty OptionsProperty =
            DependencyProperty.Register(nameof(Options), typeof(IReadOnlyList<MuiSegmentedToggleOption>), typeof(MuiSegmentedToggle),
                new PropertyMetadata(null, (d, _) => ((MuiSegmentedToggle)d).RebuildSegments()));

        public static readonly DependencyProperty SelectedIndexProperty =
            DependencyProperty.Register(nameof(SelectedIndex), typeof(int), typeof(MuiSegmentedToggle),
                new PropertyMetadata(0, (d, _) => ((MuiSegmentedToggle)d).OnSelectedIndexChanged()));

        /// <summary>Required. 2-3 entries per the contract; more render but
        /// aren't contract-covered.</summary>
        public IReadOnlyList<MuiSegmentedToggleOption>? Options
        {
            get => (IReadOnlyList<MuiSegmentedToggleOption>?)GetValue(OptionsProperty);
            set => SetValue(OptionsProperty, value);
        }

        public int SelectedIndex
        {
            get => (int)GetValue(SelectedIndexProperty);
            set => SetValue(SelectedIndexProperty, value);
        }

        /// <summary>Raised after a user click changes SelectedIndex (not
        /// raised for a programmatic SelectedIndex set).</summary>
        public event EventHandler<int>? SelectionChanged;

        private readonly Border _chrome = new()
        {
            CornerRadius = new CornerRadius(8),
            BorderThickness = new Thickness(1),
        };
        private readonly Grid _grid = new();
        private readonly Canvas _pillLayer = new();
        private readonly Border _pill = new() { CornerRadius = new CornerRadius(6) };
        private readonly TranslateTransform _pillTransform = new();
        private readonly List<ToggleButton> _segments = new();
        private bool _suppressSelectionEvent;

        public MuiSegmentedToggle()
        {
            _pill.RenderTransform = _pillTransform;
            _pillLayer.Children.Add(_pill);
            _grid.Children.Add(_pillLayer);
            _chrome.Child = _grid;
            Content = _chrome;
            IsTabStop = false;
            SizeChanged += (_, _) => PositionPill(animate: false);
            RebuildSegments();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnSelectedIndexChanged()
        {
            if (_suppressSelectionEvent) return;
            ApplySegmentVisuals();
            PositionPill(animate: true);
        }

        private void RebuildSegments()
        {
            foreach (var segment in _segments)
                _grid.Children.Remove(segment);
            _segments.Clear();
            _grid.ColumnDefinitions.Clear();

            _chrome.Background = R("MapleSurface");
            _chrome.BorderBrush = R("MapleBorder");

            var options = Options ?? Array.Empty<MuiSegmentedToggleOption>();
            Grid.SetColumnSpan(_pillLayer, Math.Max(1, options.Count));

            for (var i = 0; i < options.Count; i++)
            {
                _grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

                var index = i;
                var button = new ToggleButton
                {
                    Content = options[i].Label,
                    Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                    BorderThickness = new Thickness(0),
                    Padding = new Thickness(12, 6, 12, 6),
                    HorizontalContentAlignment = HorizontalAlignment.Center,
                    FontSize = 12,
                };
                // Same #3069 lightweight-styling override as MuiActionButton,
                // but to TRANSPARENT: a segment's own checked state must not
                // paint anything — the sliding neutral pill underneath
                // (_pill, MapleSurfaceHover) IS the selection visual, and the
                // default template's system-accent checked fill was painting
                // the user's Windows accent color over it.
                var transparent = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
                foreach (var key in new[]
                {
                    "ToggleButtonBackgroundChecked", "ToggleButtonBackgroundCheckedPointerOver", "ToggleButtonBackgroundCheckedPressed",
                    "ToggleButtonBorderBrushChecked", "ToggleButtonBorderBrushCheckedPointerOver", "ToggleButtonBorderBrushCheckedPressed",
                })
                    button.Resources[key] = transparent;
                foreach (var key in new[]
                {
                    "ToggleButtonForegroundChecked", "ToggleButtonForegroundCheckedPointerOver", "ToggleButtonForegroundCheckedPressed",
                })
                    button.Resources[key] = R("MapleTextMain");

                Grid.SetColumn(button, index);
                button.Click += (_, _) => OnSegmentClicked(index);
                if (!string.IsNullOrEmpty(options[i].AccessibleLabel))
                    AutomationProperties.SetName(button, options[i].AccessibleLabel!);

                _segments.Add(button);
                _grid.Children.Add(button);
            }

            if (SelectedIndex >= options.Count && options.Count > 0)
                SelectedIndex = 0;

            ApplySegmentVisuals();
            PositionPill(animate: false);
        }

        private void OnSegmentClicked(int index)
        {
            _suppressSelectionEvent = true;
            SelectedIndex = index;
            _suppressSelectionEvent = false;
            ApplySegmentVisuals();
            PositionPill(animate: true);
            SelectionChanged?.Invoke(this, index);
        }

        private void ApplySegmentVisuals()
        {
            for (var i = 0; i < _segments.Count; i++)
            {
                var selected = i == SelectedIndex;
                _segments[i].IsChecked = selected;
                _segments[i].Foreground = selected ? R("MapleTextMain") : R("MapleTextMuted");
            }
            _pill.Background = R("MapleSurfaceHover");
        }

        private void PositionPill(bool animate)
        {
            if (_segments.Count == 0 || ActualWidth <= 0)
                return;

            var segmentWidth = ActualWidth / _segments.Count;
            _pill.Width = Math.Max(0, segmentWidth - 4);
            _pill.Height = Math.Max(0, ActualHeight - 4);
            Canvas.SetTop(_pill, 2);

            var targetX = SelectedIndex * segmentWidth + 2;

            if (!animate)
            {
                _pillTransform.X = 0;
                Canvas.SetLeft(_pill, targetX);
                return;
            }

            var fromX = Canvas.GetLeft(_pill);
            Canvas.SetLeft(_pill, targetX);

            var anim = new DoubleAnimation
            {
                From = fromX - targetX,
                To = 0,
                Duration = new Duration(TimeSpan.FromMilliseconds(150)),
                EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
            };
            Storyboard.SetTarget(anim, _pillTransform);
            Storyboard.SetTargetProperty(anim, "X");
            var storyboard = new Storyboard();
            storyboard.Children.Add(anim);
            storyboard.Begin();
        }
    }
}
