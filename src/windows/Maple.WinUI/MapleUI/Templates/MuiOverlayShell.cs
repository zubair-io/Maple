using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Overlay Shell template (unified-component-catalog.md §5,
    /// "Overlay Shell" row: "Scrim · Header · Body · Footer", regions
    /// only) — the general-purpose surface every organism-level modal
    /// (Export, Batch Rename, Batch Metadata, Move To, …) is built on
    /// (§4.4's "All built on the Overlay Shell template"). Ports
    /// `mui-overlay-shell.component.ts`'s contract, reusing
    /// <see cref="MuiDialog"/>'s already-solved token-styled modal-hosting
    /// approach where it applies directly: a <see cref="Popup"/> scrim
    /// sized to the whole <see cref="UIElement.XamlRoot"/> (kept current
    /// via <see cref="XamlRoot.Changed"/> while open, since a WinUI Popup
    /// isn't auto-sized to its window the way a CSS <c>position: fixed</c>
    /// div is), focus-on-open, and Escape/scrim-click dismissal via the
    /// same panel-level <c>KeyDown</c>/scrim <c>Tapped</c> shape.
    ///
    /// <see cref="Contained"/> is the one thing beyond MuiDialog's own
    /// shape: with it true, the scrim/panel render INLINE in this
    /// control's own visual tree instead of in the Popup, filling
    /// whatever bounds this control is given — the demo mode every
    /// full-viewport overlay template in this wave needs so a gallery
    /// specimen can show it inside a fixed-size chip instead of covering
    /// the whole window (matching the equivalent `contained` input on the
    /// other two platforms' ports).
    /// </summary>
    public sealed class MuiOverlayShell : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiOverlayShell),
                new PropertyMetadata(false, (d, _) => ((MuiOverlayShell)d).ApplyOpenState()));

        public static readonly DependencyProperty SizeProperty =
            DependencyProperty.Register(nameof(Size), typeof(MuiOverlayShellSize), typeof(MuiOverlayShell),
                new PropertyMetadata(MuiOverlayShellSize.Md, (d, _) => ((MuiOverlayShell)d).Rebuild()));

        public static readonly DependencyProperty AriaLabelProperty =
            DependencyProperty.Register(nameof(AriaLabel), typeof(string), typeof(MuiOverlayShell),
                new PropertyMetadata("Dialog", (d, _) => ((MuiOverlayShell)d).Rebuild()));

        /// <summary>Renders inline within this control's own bounds
        /// instead of a full-viewport Popup — see the class doc
        /// comment.</summary>
        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiOverlayShell),
                new PropertyMetadata(false, (d, _) => ((MuiOverlayShell)d).ApplyOpenState()));

        public static readonly DependencyProperty HeaderProperty =
            DependencyProperty.Register(nameof(Header), typeof(UIElement), typeof(MuiOverlayShell),
                new PropertyMetadata(null, (d, _) => ((MuiOverlayShell)d).Rebuild()));

        public static readonly DependencyProperty BodyProperty =
            DependencyProperty.Register(nameof(Body), typeof(UIElement), typeof(MuiOverlayShell),
                new PropertyMetadata(null, (d, _) => ((MuiOverlayShell)d).Rebuild()));

        public static readonly DependencyProperty FooterProperty =
            DependencyProperty.Register(nameof(Footer), typeof(UIElement), typeof(MuiOverlayShell),
                new PropertyMetadata(null, (d, _) => ((MuiOverlayShell)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public MuiOverlayShellSize Size { get => (MuiOverlayShellSize)GetValue(SizeProperty); set => SetValue(SizeProperty, value); }
        public string AriaLabel { get => (string)GetValue(AriaLabelProperty); set => SetValue(AriaLabelProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }
        public UIElement? Header { get => (UIElement?)GetValue(HeaderProperty); set => SetValue(HeaderProperty, value); }

        /// <summary>The default (un-named) region.</summary>
        public UIElement? Body { get => (UIElement?)GetValue(BodyProperty); set => SetValue(BodyProperty, value); }
        public UIElement? Footer { get => (UIElement?)GetValue(FooterProperty); set => SetValue(FooterProperty, value); }

        /// <summary>Fires on Escape or a scrim click. Does NOT set
        /// <see cref="IsOpen"/> false itself — same contract as
        /// <see cref="MuiDialog"/>'s own <c>Dismissed</c> event, the
        /// caller wires the close.</summary>
        public event EventHandler? Dismissed;

        private readonly Popup _popup = new() { IsLightDismissEnabled = false };
        private readonly Grid _inlineHost = new() { IsHitTestVisible = false };
        private readonly Grid _scrim = new();
        // ContentControl, not Border/Grid — IsTabStop/Focus need a real
        // Control (same reasoning MuiDialog's own _panel gives).
        private readonly ContentControl _panel = new() { IsTabStop = true, BorderThickness = new Thickness(1) };
        private readonly StackPanel _panelBody = new() { Orientation = Orientation.Vertical, Spacing = 0 };
        private readonly Grid _headerSlot = new();
        private readonly ScrollViewer _bodyScroll = new() { Padding = new Thickness(24) };
        private readonly Grid _bodySlot = new();
        private readonly Grid _footerSlot = new();

        public MuiOverlayShell()
        {
            _bodyScroll.Content = _bodySlot;
            _panelBody.Children.Add(_headerSlot);
            _panelBody.Children.Add(_bodyScroll);
            _panelBody.Children.Add(_footerSlot);
            _panel.Content = _panelBody;
            _scrim.Children.Add(_panel);
            _scrim.HorizontalAlignment = HorizontalAlignment.Stretch;
            _scrim.VerticalAlignment = VerticalAlignment.Stretch;

            Content = _inlineHost;
            IsTabStop = false;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;
            Visibility = Visibility.Collapsed;

            _scrim.Tapped += (_, _) => Dismiss();
            _panel.Tapped += (_, e) => e.Handled = true;
            _panel.KeyDown += OnPanelKeyDown;
            _scrim.SizeChanged += (_, e) => UpdatePanelMaxHeight(e.NewSize.Height);

            Rebuild();
            ApplyOpenState();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnPanelKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key != VirtualKey.Escape) return;
            e.Handled = true;
            Dismiss();
        }

        private void Dismiss() => Dismissed?.Invoke(this, EventArgs.Empty);

        private void ApplyOpenState()
        {
            _popup.IsOpen = false;
            if (_popup.XamlRoot != null) _popup.XamlRoot.Changed -= OnXamlRootChanged;
            _popup.Child = null;
            _inlineHost.Children.Clear();

            if (!IsOpen)
            {
                Visibility = Visibility.Collapsed;
                return;
            }

            if (Contained)
            {
                _scrim.Width = double.NaN;
                _scrim.Height = double.NaN;
                Visibility = Visibility.Visible;
                _inlineHost.Children.Add(_scrim);
            }
            else
            {
                Visibility = Visibility.Collapsed;
                if (XamlRoot != null)
                {
                    _popup.XamlRoot = XamlRoot;
                    XamlRoot.Changed += OnXamlRootChanged;
                }
                _popup.Child = _scrim;
                _popup.IsOpen = true;
                ResizeScrim();
            }

            DispatcherQueue.TryEnqueue(() => _ = FocusManager.TryFocusAsync(_panel, FocusState.Programmatic));
        }

        private void OnXamlRootChanged(XamlRoot sender, XamlRootChangedEventArgs args) => ResizeScrim();

        private void ResizeScrim()
        {
            if (XamlRoot is null) return;
            _scrim.Width = XamlRoot.Size.Width;
            _scrim.Height = XamlRoot.Size.Height;
        }

        private void UpdatePanelMaxHeight(double scrimHeight)
        {
            if (Size == MuiOverlayShellSize.Full)
            {
                _panel.ClearValue(FrameworkElement.MaxHeightProperty);
                return;
            }
            // 64px == 2x the spacing-xl token, matching the web port's
            // `calc(100% - #{spacing-xl} * 2)`.
            _panel.MaxHeight = scrimHeight > 0 ? Math.Max(0, scrimHeight - 64) : double.PositiveInfinity;
        }

        private void Rebuild()
        {
            _scrim.Background = new SolidColorBrush(Windows.UI.Color.FromArgb(0x80, 0, 0, 0));
            _panel.Background = R("MapleSurface");
            _panel.BorderBrush = R("MapleBorder");
            AutomationProperties.SetName(_panel, AriaLabel);

            var full = Size == MuiOverlayShellSize.Full;
            _panel.CornerRadius = new CornerRadius(full ? 0 : 12);
            _panel.HorizontalAlignment = HorizontalAlignment.Stretch;
            _panel.VerticalAlignment = full ? VerticalAlignment.Stretch : VerticalAlignment.Center;
            _panel.MaxWidth = MuiOverlayShellMath.MaxWidthFor(Size);
            UpdatePanelMaxHeight(_scrim.ActualHeight);

            _headerSlot.Children.Clear();
            _headerSlot.Visibility = Header is not null ? Visibility.Visible : Visibility.Collapsed;
            if (Header is not null) _headerSlot.Children.Add(Header);

            _bodySlot.Children.Clear();
            if (Body is not null) _bodySlot.Children.Add(Body);

            _footerSlot.Children.Clear();
            _footerSlot.Visibility = Footer is not null ? Visibility.Visible : Visibility.Collapsed;
            if (Footer is not null) _footerSlot.Children.Add(Footer);
        }
    }
}
