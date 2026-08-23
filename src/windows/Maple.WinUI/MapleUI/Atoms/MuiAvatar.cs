using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Maple.UI.Atoms
{
    /// <summary>Avatar size (unified-component-catalog.md §1.4 Media,
    /// "Avatar" row: "Sizes: xs, sm, md, lg"). No pixel values are specified
    /// in the catalog beyond the size names themselves — these step off
    /// MuiIcon's five-step scale the same way MuiButton's Sm/Lg step off its
    /// md default, since an avatar's diameter needs to comfortably fit an
    /// Md24 icon's worth of initials text at the largest size.</summary>
    public enum MuiAvatarSize { Xs, Sm, Md, Lg }

    /// <summary>Presence indicator (catalog row: "Presence dot").</summary>
    public enum MuiAvatarPresence { None, Online, Away, Offline }

    /// <summary>
    /// Maple.UI Avatar atom (unified-component-catalog.md §1.4 Media,
    /// "Avatar" row) — a circular user image with an initials fallback.
    ///
    /// Deliberately NOT the platform <c>PersonPicture</c> control per this
    /// wave's brief: PersonPicture's built-in initials/color fallback isn't
    /// driven by Maple's own token set, so it's hand-rolled from a
    /// <see cref="Border"/> + <see cref="Image"/>/<see cref="TextBlock"/>
    /// instead, giving full control over the fallback palette and radius
    /// tokens. The fallback color pick and initials extraction are plain
    /// C# in <see cref="MuiAvatarPalette"/> (WinUI-free, unit-tested).
    /// </summary>
    public sealed class MuiAvatar : ContentControl
    {
        /// <summary>Fixed swatch palette — MaplePrimary plus a handful of
        /// desaturated accents distinct enough to read as different people
        /// at a glance, all still legible with the white-ish initials text
        /// this control always uses. No dedicated "avatar palette" token
        /// set exists in ui_tokens.rs yet, so these are literal colors
        /// (the one deliberate exception to this file's "StaticResource
        /// only" rule — there is no token to reference) rather than a
        /// guessed-at token name this wave can't compiler-verify.</summary>
        private static readonly Color[] Palette =
        {
            Color.FromArgb(0xFF, 0xC4, 0x49, 0x3A), // MaplePrimary itself
            Color.FromArgb(0xFF, 0x3A, 0x7C, 0xA8),
            Color.FromArgb(0xFF, 0x4A, 0x8C, 0x5E),
            Color.FromArgb(0xFF, 0x9C, 0x6A, 0xC4),
            Color.FromArgb(0xFF, 0xB8, 0x8A, 0x3A),
            Color.FromArgb(0xFF, 0x5A, 0x5E, 0xC4),
        };

        public static readonly DependencyProperty NameProperty =
            DependencyProperty.Register(nameof(Name), typeof(string), typeof(MuiAvatar),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiAvatar)d).Rebuild()));

        public static readonly DependencyProperty PictureProperty =
            DependencyProperty.Register(nameof(Picture), typeof(ImageSource), typeof(MuiAvatar),
                new PropertyMetadata(null, (d, _) => ((MuiAvatar)d).Rebuild()));

        public static readonly DependencyProperty AvatarSizeProperty =
            DependencyProperty.Register(nameof(AvatarSize), typeof(MuiAvatarSize), typeof(MuiAvatar),
                new PropertyMetadata(MuiAvatarSize.Md, (d, _) => ((MuiAvatar)d).Rebuild()));

        public static readonly DependencyProperty PresenceProperty =
            DependencyProperty.Register(nameof(Presence), typeof(MuiAvatarPresence), typeof(MuiAvatar),
                new PropertyMetadata(MuiAvatarPresence.None, (d, _) => ((MuiAvatar)d).Rebuild()));

        /// <summary>Drives both the initials fallback and the deterministic
        /// palette color — also the accessible name.</summary>
        public string Name
        {
            get => (string)GetValue(NameProperty);
            set => SetValue(NameProperty, value);
        }

        /// <summary>When set (and loads successfully), shown instead of the
        /// initials fallback.</summary>
        public ImageSource? Picture
        {
            get => (ImageSource?)GetValue(PictureProperty);
            set => SetValue(PictureProperty, value);
        }

        public MuiAvatarSize AvatarSize
        {
            get => (MuiAvatarSize)GetValue(AvatarSizeProperty);
            set => SetValue(AvatarSizeProperty, value);
        }

        public MuiAvatarPresence Presence
        {
            get => (MuiAvatarPresence)GetValue(PresenceProperty);
            set => SetValue(PresenceProperty, value);
        }

        private readonly Grid _root = new();
        private readonly Border _circle = new();
        private readonly Image _image = new() { Stretch = Stretch.UniformToFill };
        private readonly TextBlock _initials = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Foreground = new SolidColorBrush(Microsoft.UI.Colors.White) };
        private readonly Border _presenceDot = new() { HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom };

        public MuiAvatar()
        {
            var inner = new Grid();
            inner.Children.Add(_image);
            inner.Children.Add(_initials);
            _circle.Child = inner;
            _root.Children.Add(_circle);
            _root.Children.Add(_presenceDot);
            Content = _root;
            IsTabStop = false;

            _image.ImageFailed += (_, _) => { _image.Visibility = Visibility.Collapsed; };

            Rebuild();
        }

        private static double DiameterFor(MuiAvatarSize size) => size switch
        {
            MuiAvatarSize.Xs => 24,
            MuiAvatarSize.Sm => 32,
            MuiAvatarSize.Md => 40,
            MuiAvatarSize.Lg => 56,
            _ => 40,
        };

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            var diameter = DiameterFor(AvatarSize);
            _circle.Width = diameter;
            _circle.Height = diameter;
            _circle.CornerRadius = new CornerRadius(diameter / 2);

            var index = MuiAvatarPalette.PaletteIndex(Name, Palette.Length);
            _circle.Background = new SolidColorBrush(Palette[index]);

            _image.Source = Picture;
            _image.Visibility = Picture is null ? Visibility.Collapsed : Visibility.Visible;

            _initials.Text = MuiAvatarPalette.Initials(Name);
            _initials.FontSize = diameter <= 24 ? 10 : diameter <= 32 ? 12 : diameter <= 40 ? 14 : 18;
            _initials.FontWeight = Microsoft.UI.Text.FontWeights.Bold;
            _initials.Visibility = Picture is null ? Visibility.Visible : Visibility.Collapsed;

            var dotSize = diameter <= 24 ? 6 : diameter <= 32 ? 8 : 10;
            _presenceDot.Width = dotSize;
            _presenceDot.Height = dotSize;
            _presenceDot.CornerRadius = new CornerRadius(dotSize / 2);
            _presenceDot.BorderThickness = new Thickness(1.5);
            _presenceDot.BorderBrush = R("MapleBg");
            _presenceDot.Margin = new Thickness(0, 0, -1, -1);
            _presenceDot.Visibility = Presence == MuiAvatarPresence.None ? Visibility.Collapsed : Visibility.Visible;
            _presenceDot.Background = Presence switch
            {
                MuiAvatarPresence.Online => R("MapleSuccessText"),
                MuiAvatarPresence.Away => R("MapleWarn"),
                MuiAvatarPresence.Offline => R("MapleTextMuted"),
                _ => R("MapleTextMuted"),
            };

            if (!string.IsNullOrEmpty(Name))
                AutomationProperties.SetName(this, Name);
        }
    }
}
