using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Tree Row molecule (unified-component-catalog.md §2.2, "Tree
    /// Row" row: "One row of a hierarchical tree", built from Icon, Text,
    /// Badge, Spinner) — a List Row sibling that adds depth-based
    /// indentation and an optional expand/collapse chevron.
    ///
    /// Shares list-row.md's visual language for hover/active/disabled
    /// (Tree Row and List Row are both catalog §2.2 row primitives, and the
    /// unified guide's "active navigation row" treatment — `surface_alt`
    /// fill + 2px `primary` left border, hover composing rather than
    /// replacing — applies to any selectable row, not just List Row by
    /// name) and the same Border-root/manual-invoke pattern List Row uses
    /// so the expand chevron (a nested Button) stays independently
    /// clickable without the row's own Pressed also firing for that click.
    ///
    /// Ports `mui-tree-row.component.ts`: `depth * 16px` indent, chevron
    /// only rendered when <see cref="Expandable"/>, toggling
    /// <see cref="Expanded"/> stops the click from also firing
    /// <see cref="Pressed"/> (`event.stopPropagation()` in the web version;
    /// here that's just the chevron Button consuming its own click, per the
    /// same routed-event Handled semantics List Row's doc comment explains).
    /// </summary>
    public sealed class MuiTreeRow : ContentControl
    {
        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiTreeRow),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiTreeRow)d).Rebuild()));

        public static readonly DependencyProperty IconNameProperty =
            DependencyProperty.Register(nameof(IconName), typeof(string), typeof(MuiTreeRow),
                new PropertyMetadata("folder", (d, _) => ((MuiTreeRow)d).Rebuild()));

        public static readonly DependencyProperty ExpandableProperty =
            DependencyProperty.Register(nameof(Expandable), typeof(bool), typeof(MuiTreeRow),
                new PropertyMetadata(false, (d, _) => ((MuiTreeRow)d).Rebuild()));

        public static readonly DependencyProperty ExpandedProperty =
            DependencyProperty.Register(nameof(Expanded), typeof(bool), typeof(MuiTreeRow),
                new PropertyMetadata(false, (d, _) => ((MuiTreeRow)d).Rebuild()));

        public static readonly DependencyProperty DepthProperty =
            DependencyProperty.Register(nameof(Depth), typeof(int), typeof(MuiTreeRow),
                new PropertyMetadata(0, (d, _) => ((MuiTreeRow)d).Rebuild()));

        public static readonly DependencyProperty CountProperty =
            DependencyProperty.Register(nameof(Count), typeof(int?), typeof(MuiTreeRow),
                new PropertyMetadata(null, (d, _) => ((MuiTreeRow)d).Rebuild()));

        public static readonly DependencyProperty LoadingProperty =
            DependencyProperty.Register(nameof(Loading), typeof(bool), typeof(MuiTreeRow),
                new PropertyMetadata(false, (d, _) => ((MuiTreeRow)d).Rebuild()));

        public static readonly DependencyProperty ActiveProperty =
            DependencyProperty.Register(nameof(Active), typeof(bool), typeof(MuiTreeRow),
                new PropertyMetadata(false, (d, _) => ((MuiTreeRow)d).Rebuild()));

        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        public string IconName
        {
            get => (string)GetValue(IconNameProperty);
            set => SetValue(IconNameProperty, value);
        }

        /// <summary>Shows a leading chevron that toggles <see cref="Expanded"/>.</summary>
        public bool Expandable
        {
            get => (bool)GetValue(ExpandableProperty);
            set => SetValue(ExpandableProperty, value);
        }

        public bool Expanded
        {
            get => (bool)GetValue(ExpandedProperty);
            set => SetValue(ExpandedProperty, value);
        }

        /// <summary>Indentation level — each level adds 16px.</summary>
        public int Depth
        {
            get => (int)GetValue(DepthProperty);
            set => SetValue(DepthProperty, value);
        }

        public int? Count
        {
            get => (int?)GetValue(CountProperty);
            set => SetValue(CountProperty, value);
        }

        public bool Loading
        {
            get => (bool)GetValue(LoadingProperty);
            set => SetValue(LoadingProperty, value);
        }

        public bool Active
        {
            get => (bool)GetValue(ActiveProperty);
            set => SetValue(ActiveProperty, value);
        }

        /// <summary>Fires when <see cref="Expanded"/> is toggled via the chevron.</summary>
        public event EventHandler<bool>? ExpandedChanged;

        /// <summary>Fires on click/tap/Enter/Space anywhere in the row
        /// except the expand chevron.</summary>
        public event EventHandler? Pressed;

        private readonly Border _chrome = new() { BorderThickness = new Thickness(2, 0, 0, 0), MinHeight = 36, Padding = new Thickness(8, 6, 12, 6) };
        private readonly StackPanel _row = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
        private readonly Border _indentSpacer = new();
        private readonly Button _chevronButton = new()
        {
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(2),
            MinWidth = 0,
            MinHeight = 0,
        };
        private readonly MuiIcon _chevronIcon = new() { IconName = "chevron-right", Size = MuiIconSize.Xs14 };
        private readonly Border _chevronSpacer = new() { Width = 14 };
        private readonly MuiIcon _icon = new() { Size = MuiIconSize.Sm16 };
        private readonly MuiText _labelText = new() { Variant = MuiTextVariant.Body, Truncate = true, VerticalAlignment = VerticalAlignment.Center };
        private readonly MuiBadge _countBadge = new() { Variant = MuiBadgeVariant.Count };
        private readonly MuiSpinner _spinner = new() { SpinnerSize = MuiSpinnerSize.Sm, DelayMs = 0 };

        private bool _isPointerOver;

        public MuiTreeRow()
        {
            _row.Children.Add(_indentSpacer);
            _row.Children.Add(_chevronButton);
            _row.Children.Add(_chevronSpacer);
            _row.Children.Add(_icon);
            _row.Children.Add(_labelText);
            _row.Children.Add(_countBadge);
            _row.Children.Add(_spinner);
            _chevronButton.Content = _chevronIcon;
            _chrome.Child = _row;
            Content = _chrome;
            IsTabStop = true;

            _chevronButton.Click += (_, _) =>
            {
                if (!IsEnabled) return;
                Expanded = !Expanded;
                ExpandedChanged?.Invoke(this, Expanded);
            };
            Tapped += (_, _) => { if (IsEnabled) Pressed?.Invoke(this, EventArgs.Empty); };
            KeyDown += OnKeyDown;
            PointerEntered += (_, _) => { _isPointerOver = true; ApplyColors(); };
            PointerExited += (_, _) => { _isPointerOver = false; ApplyColors(); };
            IsEnabledChanged += (_, _) => Rebuild();

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (!IsEnabled) return;
            if (e.Key != Windows.System.VirtualKey.Enter && e.Key != Windows.System.VirtualKey.Space) return;
            e.Handled = true;
            Pressed?.Invoke(this, EventArgs.Empty);
        }

        private void ApplyColors()
        {
            _chrome.Background = Active ? R("MapleSurfaceAlt") : _isPointerOver ? R("MapleSurfaceHover") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            _chrome.BorderBrush = Active ? R("MaplePrimary") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        }

        private void Rebuild()
        {
            _indentSpacer.Width = Depth * 16;

            _chevronButton.Visibility = Expandable ? Visibility.Visible : Visibility.Collapsed;
            _chevronButton.IsEnabled = IsEnabled;
            _chevronSpacer.Visibility = Expandable ? Visibility.Collapsed : Visibility.Visible;
            _chevronIcon.IconColor = R("MapleTextMuted");
            // Rotate the chevron to point down when expanded rather than
            // swapping glyphs — MapleIconShapes has no separate
            // "chevron-down-small" distinct from the toolbar-scale one this
            // atom already uses elsewhere with different proportions.
            _chevronIcon.RenderTransformOrigin = new Windows.Foundation.Point(0.5, 0.5);
            _chevronIcon.RenderTransform = new RotateTransform { Angle = Expanded ? 90 : 0 };

            _icon.IconName = IconName;
            _icon.IconColor = R("MapleTextMuted");

            _labelText.Text = Label;

            _countBadge.Visibility = Count.HasValue ? Visibility.Visible : Visibility.Collapsed;
            _countBadge.Value = Count?.ToString() ?? string.Empty;

            _spinner.IsSpinning = Loading;
            _spinner.Visibility = Loading ? Visibility.Visible : Visibility.Collapsed;

            ApplyColors();

            Opacity = IsEnabled ? 1.0 : 0.45;

            var name = Active ? $"{Label}, current" : Label;
            AutomationProperties.SetName(this, name);
        }
    }
}
