using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Banner variant (unified-component-catalog.md §2.3, "Banner"
    /// row).</summary>
    public enum MuiBannerVariant { Info, Success, Warning, Error }

    /// <summary>
    /// Maple.UI Banner molecule (unified-component-catalog.md §2.3,
    /// "Banner" row: "Inline status strip", built from Icon, Text, Link,
    /// Button) — a colored strip for page/panel-level status, with an
    /// optional inline Link and a trailing action.
    ///
    /// Ports `mui-banner.component.ts`'s composition rule: the action slot
    /// always renders as a ghost <see cref="MuiButton"/> — there is no
    /// variant input for it, matching the catalog's per-molecule
    /// composition guidance ("a Banner uses ghost Buttons, not primary").
    /// Variant color/icon mapping mirrors MuiToast's own
    /// info/success/warning/error scheme for visual consistency across the
    /// two "colored status surface" atoms/molecules in this library.
    /// </summary>
    public sealed class MuiBanner : ContentControl
    {
        public static readonly DependencyProperty VariantProperty =
            DependencyProperty.Register(nameof(Variant), typeof(MuiBannerVariant), typeof(MuiBanner),
                new PropertyMetadata(MuiBannerVariant.Info, (d, _) => ((MuiBanner)d).Rebuild()));

        public static readonly DependencyProperty MessageProperty =
            DependencyProperty.Register(nameof(Message), typeof(string), typeof(MuiBanner),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiBanner)d).Rebuild()));

        public static readonly DependencyProperty LinkLabelProperty =
            DependencyProperty.Register(nameof(LinkLabel), typeof(string), typeof(MuiBanner),
                new PropertyMetadata(null, (d, _) => ((MuiBanner)d).Rebuild()));

        public static readonly DependencyProperty LinkHrefProperty =
            DependencyProperty.Register(nameof(LinkHref), typeof(string), typeof(MuiBanner),
                new PropertyMetadata(null, (d, _) => ((MuiBanner)d).Rebuild()));

        public static readonly DependencyProperty ActionLabelProperty =
            DependencyProperty.Register(nameof(ActionLabel), typeof(string), typeof(MuiBanner),
                new PropertyMetadata(null, (d, _) => ((MuiBanner)d).Rebuild()));

        public static readonly DependencyProperty DismissibleProperty =
            DependencyProperty.Register(nameof(Dismissible), typeof(bool), typeof(MuiBanner),
                new PropertyMetadata(false, (d, _) => ((MuiBanner)d).Rebuild()));

        public MuiBannerVariant Variant
        {
            get => (MuiBannerVariant)GetValue(VariantProperty);
            set => SetValue(VariantProperty, value);
        }

        public string Message
        {
            get => (string)GetValue(MessageProperty);
            set => SetValue(MessageProperty, value);
        }

        public string? LinkLabel
        {
            get => (string?)GetValue(LinkLabelProperty);
            set => SetValue(LinkLabelProperty, value);
        }

        public string? LinkHref
        {
            get => (string?)GetValue(LinkHrefProperty);
            set => SetValue(LinkHrefProperty, value);
        }

        public string? ActionLabel
        {
            get => (string?)GetValue(ActionLabelProperty);
            set => SetValue(ActionLabelProperty, value);
        }

        public bool Dismissible
        {
            get => (bool)GetValue(DismissibleProperty);
            set => SetValue(DismissibleProperty, value);
        }

        public event EventHandler? ActionPressed;
        public event EventHandler? Dismissed;

        private readonly Border _card = new() { CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(1), Padding = new Thickness(14, 10, 14, 10) };
        private readonly StackPanel _row = new() { Orientation = Orientation.Horizontal, Spacing = 10 };
        private readonly MuiIcon _icon = new() { Size = MuiIconSize.Sm16 };
        private readonly MuiText _messageText = new() { Variant = MuiTextVariant.Body, LineClamp = 3 };
        private readonly MuiLink _link = new();
        private readonly MuiButton _actionButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm };
        private readonly Button _closeButton = new()
        {
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(2),
            MinWidth = 0,
            MinHeight = 0,
        };

        public MuiBanner()
        {
            _row.Children.Add(_icon);
            _row.Children.Add(_messageText);
            _row.Children.Add(_link);
            _row.Children.Add(_actionButton);
            _closeButton.Content = new MuiIcon { IconName = "x", Size = MuiIconSize.Xs14 };
            _row.Children.Add(_closeButton);
            _card.Child = _row;
            Content = _card;
            IsTabStop = false;

            _actionButton.Click += (_, _) => ActionPressed?.Invoke(this, EventArgs.Empty);
            _closeButton.Click += (_, _) => Dismissed?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            var (bg, border, fg, iconName) = Variant switch
            {
                MuiBannerVariant.Success => (R("MapleSuccessBg"), R("MapleSuccessText"), R("MapleSuccessText"), "check"),
                MuiBannerVariant.Warning => (R("MaplePrimaryDim"), R("MapleWarn"), R("MapleWarn"), "flag"),
                MuiBannerVariant.Error => (R("MapleErrorBg"), R("MapleErrorText"), R("MapleErrorText"), "clear-circle-fill"),
                _ => (R("MapleSurfaceAlt"), R("MapleBorder"), R("MapleTextMain"), "info"),
            };

            _card.Background = bg;
            _card.BorderBrush = border;
            _icon.IconName = iconName;
            _icon.IconColor = fg;
            _messageText.Text = Message;

            var hasLink = !string.IsNullOrEmpty(LinkLabel) && !string.IsNullOrEmpty(LinkHref);
            _link.Label = LinkLabel ?? string.Empty;
            _link.Href = LinkHref ?? string.Empty;
            _link.Visibility = hasLink ? Visibility.Visible : Visibility.Collapsed;

            _actionButton.Label = ActionLabel ?? string.Empty;
            _actionButton.Visibility = string.IsNullOrEmpty(ActionLabel) ? Visibility.Collapsed : Visibility.Visible;

            _closeButton.Visibility = Dismissible ? Visibility.Visible : Visibility.Collapsed;

            if (!string.IsNullOrEmpty(Message))
                AutomationProperties.SetName(this, Message);
        }
    }
}
