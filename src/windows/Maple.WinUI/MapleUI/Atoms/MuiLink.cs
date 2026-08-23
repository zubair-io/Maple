using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI.Atoms
{
    /// <summary>
    /// Maple.UI Link atom (docs/design/maple-ui/components/link.md) — an
    /// inline hyperlink. Built on <see cref="HyperlinkButton"/> so external
    /// navigation (launching the default browser) comes from the platform's
    /// own NavigateUri handling rather than a hand-rolled process launch.
    ///
    /// Disabled uses the base Control.IsEnabled directly rather than a
    /// separate DependencyProperty (link.md lists `disabled` as a prop, but
    /// IsEnabled already is exactly that switch, and every other Maple.UI
    /// atom follows the same convention — see MuiButton).
    ///
    /// Not implemented: the Visited state. There is no platform-native
    /// "has this URI been opened before" signal to hook without a
    /// browsing-history store of our own, which is out of scope for this
    /// atom (link.md's Visited state is a styling hook, not a data feature
    /// this control owns).
    /// </summary>
    public sealed class MuiLink : HyperlinkButton
    {
        public static readonly DependencyProperty HrefProperty =
            DependencyProperty.Register(nameof(Href), typeof(string), typeof(MuiLink),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiLink)d).Rebuild()));

        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiLink),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiLink)d).Rebuild()));

        public static readonly DependencyProperty ExternalProperty =
            DependencyProperty.Register(nameof(External), typeof(bool), typeof(MuiLink),
                new PropertyMetadata(false, (d, _) => ((MuiLink)d).Rebuild()));

        public string Href
        {
            get => (string)GetValue(HrefProperty);
            set => SetValue(HrefProperty, value);
        }

        /// <summary>The visible and accessible text. Required.</summary>
        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        /// <summary>When true: renders the trailing "opens elsewhere"
        /// affordance glyph and lets NavigateUri auto-launch the system
        /// browser. When false (internal navigation): NavigateUri stays
        /// null and the host handles same-app routing via Click.</summary>
        public bool External
        {
            get => (bool)GetValue(ExternalProperty);
            set => SetValue(ExternalProperty, value);
        }

        private readonly StackPanel _content = new() { Orientation = Orientation.Horizontal, Spacing = 4 };
        private readonly TextBlock _label = new();
        private readonly MuiIcon _icon = new() { IconName = "share-up-square", Size = MuiIconSize.Xs14 };

        public MuiLink()
        {
            _label.Style = (Style)Application.Current.Resources["MuiLinkTextStyle"];
            _content.Children.Add(_label);
            _content.Children.Add(_icon);
            Content = _content;
            Padding = new Thickness(0);
            IsEnabledChanged += (_, _) => Rebuild();
            Rebuild();
        }

        private void Rebuild()
        {
            _label.Text = Label;
            _icon.Visibility = External ? Visibility.Visible : Visibility.Collapsed;

            // link.md § States, Disabled: "50% opacity ... href removed so
            // it's inert even if a click handler is bypassed."
            Opacity = IsEnabled ? 1.0 : 0.5;

            NavigateUri = IsEnabled && External && Uri.TryCreate(Href, UriKind.Absolute, out var uri)
                ? uri
                : null;

            if (!string.IsNullOrEmpty(Label))
                AutomationProperties.SetName(this, Label);
        }
    }
}
