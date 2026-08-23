using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One tab.</summary>
    public readonly record struct MuiTab(string Id, string Label, string? IconName = null);

    /// <summary>
    /// Maple.UI Tabs molecule (unified-component-catalog.md §2.2, "Tabs"
    /// row: "Tab row with selection indicator", built from Text, Icon) — a
    /// tab strip with an animated sliding underline, roving tabindex per
    /// the WAI-ARIA tabs pattern (only the active tab is in the tab order;
    /// Left/Right/Home/End move both focus and selection).
    ///
    /// Each tab is a plain <see cref="Button"/> (ghost-styled) rather than
    /// a hand-rolled hit target — same reasoning MuiButton's own doc
    /// comment gives — which is also what makes roving tabindex possible
    /// for free via <see cref="Control.IsTabStop"/> and
    /// <see cref="Control.Focus"/> (a bare Border can't receive keyboard
    /// focus). The underline indicator slides via a
    /// <see cref="TranslateTransform"/> + <see cref="DoubleAnimation"/>,
    /// the same conservative single-Storyboard-property approach
    /// MuiSegmentedToggle's pill motion already uses in this library.
    /// Ports `mui-tabs.component.ts`'s measure/select/keydown contract.
    /// </summary>
    public sealed class MuiTabs : ContentControl
    {
        public static readonly DependencyProperty TabsProperty =
            DependencyProperty.Register(nameof(Tabs), typeof(IReadOnlyList<MuiTab>), typeof(MuiTabs),
                new PropertyMetadata(null, (d, _) => ((MuiTabs)d).RebuildTabs()));

        public static readonly DependencyProperty ActiveIdProperty =
            DependencyProperty.Register(nameof(ActiveId), typeof(string), typeof(MuiTabs),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiTabs)d).OnActiveIdChanged()));

        public static readonly DependencyProperty AriaLabelProperty =
            DependencyProperty.Register(nameof(AriaLabel), typeof(string), typeof(MuiTabs),
                new PropertyMetadata("Tabs", (d, _) => ((MuiTabs)d).Rebuild()));

        public IReadOnlyList<MuiTab>? Tabs
        {
            get => (IReadOnlyList<MuiTab>?)GetValue(TabsProperty);
            set => SetValue(TabsProperty, value);
        }

        public string ActiveId
        {
            get => (string)GetValue(ActiveIdProperty);
            set => SetValue(ActiveIdProperty, value);
        }

        public string AriaLabel
        {
            get => (string)GetValue(AriaLabelProperty);
            set => SetValue(AriaLabelProperty, value);
        }

        /// <summary>Fires after a click/keyboard selection change.</summary>
        public event EventHandler<string>? SelectionChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 0 };
        private readonly Grid _tabRow = new();
        private readonly Canvas _indicatorLayer = new() { Height = 2 };
        private readonly Border _indicator = new() { Height = 2, HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top };
        private readonly TranslateTransform _indicatorTransform = new();
        private readonly List<Button> _tabButtons = new();

        public MuiTabs()
        {
            _indicator.RenderTransform = _indicatorTransform;
            _indicatorLayer.Children.Add(_indicator);
            _root.Children.Add(_tabRow);
            _root.Children.Add(_indicatorLayer);
            Content = _root;
            IsTabStop = false;
            AutomationProperties.SetAccessibilityView(this, AccessibilityView.Content);

            SizeChanged += (_, _) => PositionIndicator(animate: false);

            RebuildTabs();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnActiveIdChanged()
        {
            ApplyTabVisuals();
            PositionIndicator(animate: true);
        }

        private void RebuildTabs()
        {
            foreach (var button in _tabButtons)
                _tabRow.Children.Remove(button);
            _tabButtons.Clear();
            _tabRow.ColumnDefinitions.Clear();

            var tabs = Tabs ?? Array.Empty<MuiTab>();
            for (var i = 0; i < tabs.Count; i++)
            {
                _tabRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                var index = i;
                var tab = tabs[i];
                var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
                if (!string.IsNullOrEmpty(tab.IconName))
                    content.Children.Add(new MuiIcon { IconName = tab.IconName, Size = MuiIconSize.Sm16 });
                content.Children.Add(new MuiText { Text = tab.Label, Variant = MuiTextVariant.RowLabel });

                var button = new Button
                {
                    Content = content,
                    Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                    BorderThickness = new Thickness(0),
                    Padding = new Thickness(14, 10, 14, 10),
                };
                Grid.SetColumn(button, index);
                button.Click += (_, _) => Select(tab.Id);
                button.KeyDown += (_, e) => OnTabKeyDown(e, index);

                _tabButtons.Add(button);
                _tabRow.Children.Add(button);
            }

            if (tabs.Count > 0 && string.IsNullOrEmpty(ActiveId))
                ActiveId = tabs[0].Id;

            Rebuild();
            ApplyTabVisuals();
            DispatcherQueue.TryEnqueue(() => PositionIndicator(animate: false));
        }

        private void Select(string id)
        {
            if (id == ActiveId) return;
            ActiveId = id;
            SelectionChanged?.Invoke(this, id);
        }

        private void OnTabKeyDown(KeyRoutedEventArgs e, int index)
        {
            var tabs = Tabs ?? Array.Empty<MuiTab>();
            if (tabs.Count == 0) return;

            int? nextIndex = e.Key switch
            {
                Windows.System.VirtualKey.Right => (index + 1) % tabs.Count,
                Windows.System.VirtualKey.Left => (index - 1 + tabs.Count) % tabs.Count,
                Windows.System.VirtualKey.Home => 0,
                Windows.System.VirtualKey.End => tabs.Count - 1,
                _ => null,
            };
            if (nextIndex is not { } next) return;

            e.Handled = true;
            Select(tabs[next].Id);
            DispatcherQueue.TryEnqueue(() => _tabButtons[next].Focus(FocusState.Keyboard));
        }

        private void ApplyTabVisuals()
        {
            var tabs = Tabs ?? Array.Empty<MuiTab>();
            for (var i = 0; i < _tabButtons.Count; i++)
            {
                var active = i < tabs.Count && tabs[i].Id == ActiveId;
                _tabButtons[i].Foreground = active ? R("MapleTextMain") : R("MapleTextMuted");
                // Roving tabindex (WAI-ARIA tabs pattern): only the active
                // tab sits in the tab order.
                _tabButtons[i].IsTabStop = active;
            }
        }

        private void PositionIndicator(bool animate)
        {
            var tabs = Tabs ?? Array.Empty<MuiTab>();
            var index = -1;
            for (var i = 0; i < tabs.Count; i++)
                if (tabs[i].Id == ActiveId) { index = i; break; }
            if (index < 0 || index >= _tabButtons.Count) return;

            double offsetX = 0;
            for (var i = 0; i < index; i++)
                offsetX += _tabButtons[i].ActualWidth;
            var width = _tabButtons[index].ActualWidth;
            if (width <= 0) return;

            _indicator.Width = width;

            if (!animate)
            {
                _indicatorTransform.X = 0;
                Canvas.SetLeft(_indicator, offsetX);
                return;
            }

            var fromX = Canvas.GetLeft(_indicator);
            Canvas.SetLeft(_indicator, offsetX);

            var anim = new DoubleAnimation
            {
                From = fromX - offsetX,
                To = 0,
                Duration = new Duration(TimeSpan.FromMilliseconds(150)),
                EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
            };
            Storyboard.SetTarget(anim, _indicatorTransform);
            Storyboard.SetTargetProperty(anim, "X");
            var storyboard = new Storyboard();
            storyboard.Children.Add(anim);
            storyboard.Begin();
        }

        private void Rebuild()
        {
            _indicator.Background = R("MaplePrimary");
            AutomationProperties.SetName(this, AriaLabel);
        }
    }
}
