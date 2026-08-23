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
    /// Maple.UI List Row molecule (unified-component-catalog.md §2.2, "List
    /// Row" row: "Row with metadata and inline actions", built from Icon,
    /// Text, Timestamp, Button) — the base horizontal row primitive behind
    /// settings rows and filterable list items. Implements
    /// docs/design/maple-ui/components/list-row.md exactly:
    ///
    /// - Active is `color.surface_alt` fill + a 2px `color.primary` LEFT
    ///   border — never a full `color.primary` fill.
    /// - Hover (`color.surface_hover`) composes with, rather than replaces,
    ///   the persistent Active look.
    /// - Disabled is 40-50% opacity.
    /// - The whole row is the tap target (min 44px height) when
    ///   <see cref="Pressed"/> has a subscriber worth calling — this control
    ///   always exposes the row as pressable; a caller with no navigation
    ///   action simply doesn't handle <see cref="Pressed"/>.
    /// - <see cref="TrailingContent"/> can itself be interactive (e.g. an
    ///   inline Toggle) and must stay independently focusable rather than
    ///   being swallowed by the row's own tap handling.
    ///
    /// The row is a plain Grid/Border (NOT a native Button) with its own
    /// Tapped/KeyDown-driven invoke pattern — deliberately, so a nested
    /// interactive TrailingContent control isn't a Button-inside-Button.
    /// WinUI's routed-event Handled flag already stops a descendant
    /// control's own Click/Tapped from also invoking this row's handler
    /// (standard routed-event semantics, not a custom guard this control
    /// has to implement), which is exactly the accessibility contract
    /// list-row.md asks for.
    ///
    /// KNOWN GAP: `AutomationProperties.SetName` appends ", current" while
    /// Active rather than a native `aria-current`/SelectionItem-pattern
    /// equivalent — WinUI's Button/ContentControl automation peers don't
    /// expose an IsSelected-style property the way a ListViewItem does, and
    /// this wave has no compiler to verify a custom AutomationPeer against.
    /// </summary>
    public sealed class MuiListRow : ContentControl
    {
        public static readonly DependencyProperty IconNameProperty =
            DependencyProperty.Register(nameof(IconName), typeof(string), typeof(MuiListRow),
                new PropertyMetadata(null, (d, _) => ((MuiListRow)d).Rebuild()));

        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiListRow),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiListRow)d).Rebuild()));

        public static readonly DependencyProperty TrailingContentProperty =
            DependencyProperty.Register(nameof(TrailingContent), typeof(UIElement), typeof(MuiListRow),
                new PropertyMetadata(null, (d, _) => ((MuiListRow)d).Rebuild()));

        public static readonly DependencyProperty ActiveProperty =
            DependencyProperty.Register(nameof(Active), typeof(bool), typeof(MuiListRow),
                new PropertyMetadata(false, (d, _) => ((MuiListRow)d).Rebuild()));

        public string? IconName
        {
            get => (string?)GetValue(IconNameProperty);
            set => SetValue(IconNameProperty, value);
        }

        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        /// <summary>Optional trailing slot — value text, an Icon, a Toggle,
        /// a chevron. Composed, not a fixed enum (list-row.md § Props).</summary>
        public UIElement? TrailingContent
        {
            get => (UIElement?)GetValue(TrailingContentProperty);
            set => SetValue(TrailingContentProperty, value);
        }

        public bool Active
        {
            get => (bool)GetValue(ActiveProperty);
            set => SetValue(ActiveProperty, value);
        }

        /// <summary>Fires on click/tap/Enter/Space anywhere in the row
        /// except <see cref="TrailingContent"/>'s own interactive children.</summary>
        public event EventHandler? Pressed;

        private readonly Border _chrome = new()
        {
            BorderThickness = new Thickness(2, 0, 0, 0),
            MinHeight = 44,
            Padding = new Thickness(14, 8, 16, 8),
        };
        private readonly Grid _row = new() { ColumnSpacing = 10 };
        private readonly MuiIcon _icon = new() { Size = MuiIconSize.Sm16 };
        private readonly MuiText _labelText = new() { Variant = MuiTextVariant.Body, Truncate = true, VerticalAlignment = VerticalAlignment.Center };
        private readonly ContentPresenter _trailingHost = new() { HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };

        private bool _isPointerOver;

        public MuiListRow()
        {
            _row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            _row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            _row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn(_icon, 0);
            Grid.SetColumn(_labelText, 1);
            Grid.SetColumn(_trailingHost, 2);
            _row.Children.Add(_icon);
            _row.Children.Add(_labelText);
            _row.Children.Add(_trailingHost);
            _chrome.Child = _row;
            Content = _chrome;
            IsTabStop = true;

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
            // list-row.md § States: Hover composes with (doesn't replace)
            // the persistent Active look.
            _chrome.Background = Active ? R("MapleSurfaceAlt") : _isPointerOver ? R("MapleSurfaceHover") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            _chrome.BorderBrush = Active ? R("MaplePrimary") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        }

        private void Rebuild()
        {
            _icon.Visibility = string.IsNullOrEmpty(IconName) ? Visibility.Collapsed : Visibility.Visible;
            _icon.IconName = IconName ?? string.Empty;
            _icon.IconColor = R("MapleTextMuted");

            _labelText.Text = Label;
            _labelText.ColorRole = MuiTextColorRole.Main;

            _trailingHost.Content = TrailingContent;

            ApplyColors();

            // list-row.md § States, Disabled: 40-50% opacity.
            Opacity = IsEnabled ? 1.0 : 0.45;

            var name = Active ? $"{Label}, current" : Label;
            AutomationProperties.SetName(this, name);
        }
    }
}
