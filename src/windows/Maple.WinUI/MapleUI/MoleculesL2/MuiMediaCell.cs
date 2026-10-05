using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Media Cell size (unified-component-catalog.md §3, "Media
    /// Cell" row + `mui-media-cell.component.ts`'s <c>MuiMediaCellSize</c>).</summary>
    public enum MuiMediaCellSize { Sm, Md, Filmstrip }

    /// <summary>
    /// Maple.UI Media Cell molecule (unified-component-catalog.md §3,
    /// "Media Cell" row: "Thumbnail with badges, rating, selection", built
    /// from Image, Badge, Rating &amp; Flags, Inline Rename Field) — the
    /// core grid-cell primitive Filmstrip Row/Rail (and, later, Collection
    /// Grid) compose.
    ///
    /// Ports `mui-media-cell.component.html`'s layout: a thumbnail with an
    /// overlaid badge row, and a meta row below (rename field + rating/
    /// flags) that stops its own taps/keys from reaching the cell's own
    /// <see cref="Pressed"/> — the same "meta row owns its own
    /// interaction" contract the web template's
    /// <c>(click)="$event.stopPropagation()"</c> on <c>.meta</c> gives.
    /// Metadata taps stop at the row; the cell's key handler ignores
    /// metadata descendants without swallowing their native text editing.
    /// </summary>
    public sealed class MuiMediaCell : ContentControl
    {
        public static readonly DependencyProperty ThumbnailAspectRatioProperty =
            DependencyProperty.Register(nameof(ThumbnailAspectRatio), typeof(double), typeof(MuiMediaCell),
                new PropertyMetadata(1.0, (d, _) => ((MuiMediaCell)d).Rebuild()));

        public double ThumbnailAspectRatio
        {
            get => (double)GetValue(ThumbnailAspectRatioProperty);
            set => SetValue(ThumbnailAspectRatioProperty, value);
        }
        public static readonly DependencyProperty SourceProperty =
            DependencyProperty.Register(nameof(Source), typeof(ImageSource), typeof(MuiMediaCell),
                new PropertyMetadata(null, (d, _) => ((MuiMediaCell)d).Rebuild()));

        public static readonly DependencyProperty AltProperty =
            DependencyProperty.Register(nameof(Alt), typeof(string), typeof(MuiMediaCell),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiMediaCell)d).Rebuild()));

        public static readonly DependencyProperty FilenameProperty =
            DependencyProperty.Register(nameof(Filename), typeof(string), typeof(MuiMediaCell),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiMediaCell)d).Rebuild()));

        public static readonly DependencyProperty BadgesProperty =
            DependencyProperty.Register(nameof(Badges), typeof(IReadOnlyList<string>), typeof(MuiMediaCell),
                new PropertyMetadata(null, (d, _) => ((MuiMediaCell)d).RebuildBadges()));

        public static readonly DependencyProperty SelectedProperty =
            DependencyProperty.Register(nameof(Selected), typeof(bool), typeof(MuiMediaCell),
                new PropertyMetadata(false, (d, _) => ((MuiMediaCell)d).Rebuild()));

        public static readonly DependencyProperty CellSizeProperty =
            DependencyProperty.Register(nameof(CellSize), typeof(MuiMediaCellSize), typeof(MuiMediaCell),
                new PropertyMetadata(MuiMediaCellSize.Md, (d, _) => ((MuiMediaCell)d).Rebuild()));

        public static readonly DependencyProperty ShowMetadataProperty =
            DependencyProperty.Register(nameof(ShowMetadata), typeof(bool), typeof(MuiMediaCell),
                new PropertyMetadata(true, (d, _) => ((MuiMediaCell)d).Rebuild()));

        public static readonly DependencyProperty RatingProperty =
            DependencyProperty.Register(nameof(Rating), typeof(int), typeof(MuiMediaCell),
                new PropertyMetadata(0, (d, e) => ((MuiMediaCell)d)._ratingFlags.Rating = (int)e.NewValue));

        public static readonly DependencyProperty FlagProperty =
            DependencyProperty.Register(nameof(Flag), typeof(MuiRatingFlagState), typeof(MuiMediaCell),
                new PropertyMetadata(MuiRatingFlagState.None, (d, e) => ((MuiMediaCell)d)._ratingFlags.Flag = (MuiRatingFlagState)e.NewValue));

        public ImageSource? Source
        {
            get => (ImageSource?)GetValue(SourceProperty);
            set => SetValue(SourceProperty, value);
        }

        public string Alt
        {
            get => (string)GetValue(AltProperty);
            set => SetValue(AltProperty, value);
        }

        public string Filename
        {
            get => (string)GetValue(FilenameProperty);
            set => SetValue(FilenameProperty, value);
        }

        /// <summary>Short badge labels rendered atop the thumbnail (e.g.
        /// media type, "RAW").</summary>
        public IReadOnlyList<string>? Badges
        {
            get => (IReadOnlyList<string>?)GetValue(BadgesProperty);
            set => SetValue(BadgesProperty, value);
        }

        public bool Selected
        {
            get => (bool)GetValue(SelectedProperty);
            set => SetValue(SelectedProperty, value);
        }

        public MuiMediaCellSize CellSize
        {
            get => (MuiMediaCellSize)GetValue(CellSizeProperty);
            set => SetValue(CellSizeProperty, value);
        }

        /// <summary>Navigation strips show thumbnails and passive badges;
        /// only hosts that wire metadata editing expose the editable row.</summary>
        public bool ShowMetadata
        {
            get => (bool)GetValue(ShowMetadataProperty);
            set => SetValue(ShowMetadataProperty, value);
        }

        public int Rating
        {
            get => (int)GetValue(RatingProperty);
            set => SetValue(RatingProperty, value);
        }

        public MuiRatingFlagState Flag
        {
            get => (MuiRatingFlagState)GetValue(FlagProperty);
            set => SetValue(FlagProperty, value);
        }

        /// <summary>Fires on a click/tap/Enter/Space on the thumbnail —
        /// not the rename field or rating row, which own their own
        /// interactions. The caller decides what a press means (select,
        /// open, toggle).</summary>
        public event EventHandler? Pressed
        {
            add { _pressed += value; UpdateActionAvailability(); }
            remove { _pressed -= value; UpdateActionAvailability(); }
        }

        private EventHandler? _pressed;
        internal bool HasPressAction => _pressed != null;

        public event EventHandler<string>? Renamed;

        private readonly Border _chrome = new() { BorderThickness = new Thickness(2), CornerRadius = new CornerRadius(10) };
        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 6 };
        private readonly Grid _thumbHost = new();
        private readonly MuiImage _image = new() { Fit = MuiImageFit.Fill, ImageCornerRadius = 6 };
        private readonly StackPanel _badgeRow = new()
        {
            Orientation = Orientation.Horizontal,
            Spacing = 4,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(6),
        };
        private readonly StackPanel _metaRow = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiInlineRenameField _renameField = new();
        private readonly MuiRatingFlags _ratingFlags = new();

        public MuiMediaCell()
        {
            _thumbHost.Children.Add(_image);
            _thumbHost.Children.Add(_badgeRow);
            _metaRow.Children.Add(_renameField);
            _metaRow.Children.Add(_ratingFlags);
            _root.Children.Add(_thumbHost);
            _root.Children.Add(_metaRow);
            _chrome.Child = _root;
            Content = _chrome;
            IsTabStop = false;
            UseSystemFocusVisuals = true;
            FocusVisualPrimaryBrush = R("MapleTextMain");
            FocusVisualSecondaryBrush = R("MapleSurface");

            Tapped += (_, e) => { if (IsEnabled && !IsFromMetadata(e.OriginalSource)) InvokeAction(); };
            KeyDown += OnKeyDown;
            // Ignore metadata keys in OnKeyDown; handling every key here
            // prevents the TextBox from processing native editing input.
            _metaRow.Tapped += (_, e) => e.Handled = true;
            _renameField.Renamed += (_, name) => { Filename = name; Renamed?.Invoke(this, name); };
            _ratingFlags.RatingChanged += (_, value) => Rating = value;
            _ratingFlags.FlagChanged += (_, value) => Flag = value;
            IsEnabledChanged += (_, _) => Rebuild();

            RebuildBadges();
            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        protected override AutomationPeer OnCreateAutomationPeer() => new MuiMediaCellAutomationPeer(this);

        private void UpdateActionAvailability()
        {
            IsTabStop = HasPressAction;
            FrameworkElementAutomationPeer.FromElement(this)?.InvalidatePeer();
        }

        internal void InvokeAction()
        {
            if (!IsEnabled) throw new ElementNotEnabledException();
            var action = _pressed;
            if (action == null) return;
            action.Invoke(this, EventArgs.Empty);
            FrameworkElementAutomationPeer.FromElement(this)?.RaiseAutomationEvent(AutomationEvents.InvokePatternOnInvoked);
        }

        private bool IsFromMetadata(object source)
        {
            for (var node = source as DependencyObject; node != null; node = VisualTreeHelper.GetParent(node))
            {
                if (ReferenceEquals(node, _metaRow)) return true;
                if (ReferenceEquals(node, this)) return false;
            }
            return false;
        }

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (!IsEnabled || !HasPressAction || IsFromMetadata(e.OriginalSource)) return;
            if (e.Key != Windows.System.VirtualKey.Enter && e.Key != Windows.System.VirtualKey.Space) return;
            e.Handled = true;
            InvokeAction();
        }

        private void RebuildBadges()
        {
            _badgeRow.Children.Clear();
            foreach (var label in Badges ?? Array.Empty<string>())
                _badgeRow.Children.Add(new MuiBadge { Variant = MuiBadgeVariant.Count, Value = label });
        }

        private void Rebuild()
        {
            // The vNext editor rail uses 64px images inside an 80px surface.
            var side = CellSize switch { MuiMediaCellSize.Filmstrip => 64, MuiMediaCellSize.Sm => 72, _ => 128 };
            _thumbHost.Width = side;
            _thumbHost.Height = side / (ThumbnailAspectRatio > 0 ? ThumbnailAspectRatio : 1);
            _image.Source = Source;
            _image.AccessibleLabel = Alt;
            _metaRow.Visibility = ShowMetadata ? Visibility.Visible : Visibility.Collapsed;

            _renameField.Value = Filename;
            _renameField.AccessibleLabel = $"Rename {Filename}";

            _chrome.Background = ShowMetadata ? R("MapleSurface") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            _chrome.BorderBrush = Selected ? R("MaplePrimary") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            _chrome.Padding = new Thickness(ShowMetadata ? 6 : 0);
            _chrome.CornerRadius = new CornerRadius(ShowMetadata ? 10 : 3);
            _image.ImageCornerRadius = ShowMetadata ? 6 : 1;

            Opacity = IsEnabled ? 1.0 : 0.45;

            AutomationProperties.SetName(this, string.IsNullOrEmpty(Alt) ? Filename : Alt);
            AutomationProperties.SetItemStatus(this, Selected ? "Selected" : string.Empty);
            FrameworkElementAutomationPeer.FromElement(this)?.InvalidatePeer();
        }
    }
}
