using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace Maple.UI
{
    /// <summary>Which edge <see cref="MuiDrawerShell"/> slides in
    /// from.</summary>
    public enum MuiDrawerShellEdge { Left, Right }

    /// <summary>
    /// Maple.UI Drawer Shell template (unified-component-catalog.md §5,
    /// "Drawer Shell" row: "Scrim · Panel", regions only) — a plain,
    /// gesture-free edge panel: no header/search/tree of its own, unlike
    /// the phone-only source-picker drawer this generalizes on the web
    /// port. <see cref="Edge"/> picks either side, <see cref="PanelWidth"/>
    /// sets the fixed panel width (named <c>PanelWidth</c>, not
    /// <c>Width</c> — <see cref="FrameworkElement.Width"/> is already a
    /// base property; shadowing it would be exactly the kind of
    /// base-member collision this wave's brief calls out to avoid).
    ///
    /// Dismissal is Escape and a scrim click, reusing
    /// <see cref="MuiDialog"/>'s panel-KeyDown / scrim-Tapped shape.
    /// <see cref="Contained"/> reuses <see cref="MuiDialog"/>'s
    /// Popup-vs-inline approach — see <see cref="MuiOverlayShell"/>'s own
    /// doc comment for the shared rationale.
    /// </summary>
    public sealed class MuiDrawerShell : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiDrawerShell),
                new PropertyMetadata(false, (d, _) => ((MuiDrawerShell)d).ApplyOpenState()));

        public static readonly DependencyProperty EdgeProperty =
            DependencyProperty.Register(nameof(Edge), typeof(MuiDrawerShellEdge), typeof(MuiDrawerShell),
                new PropertyMetadata(MuiDrawerShellEdge.Left, (d, _) => ((MuiDrawerShell)d).Rebuild()));

        public static readonly DependencyProperty PanelWidthProperty =
            DependencyProperty.Register(nameof(PanelWidth), typeof(double), typeof(MuiDrawerShell),
                new PropertyMetadata(320.0, (d, _) => ((MuiDrawerShell)d).ApplyPanelWidth()));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiDrawerShell),
                new PropertyMetadata(false, (d, _) => ((MuiDrawerShell)d).ApplyOpenState()));

        public static readonly DependencyProperty PanelContentProperty =
            DependencyProperty.Register(nameof(PanelContent), typeof(UIElement), typeof(MuiDrawerShell),
                new PropertyMetadata(null, (d, _) => ((MuiDrawerShell)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public MuiDrawerShellEdge Edge { get => (MuiDrawerShellEdge)GetValue(EdgeProperty); set => SetValue(EdgeProperty, value); }
        public double PanelWidth { get => (double)GetValue(PanelWidthProperty); set => SetValue(PanelWidthProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }

        /// <summary>The default (un-named) region — the drawer's whole
        /// panel content.</summary>
        public UIElement? PanelContent { get => (UIElement?)GetValue(PanelContentProperty); set => SetValue(PanelContentProperty, value); }

        /// <summary>Fires on Escape or a scrim click. Does NOT set
        /// <see cref="IsOpen"/> false itself — same contract as
        /// <see cref="MuiDialog"/>'s own <c>Dismissed</c> event.</summary>
        public event EventHandler? Dismissed;

        private readonly Popup _popup = new() { IsLightDismissEnabled = false };
        private readonly Grid _inlineHost = new() { IsHitTestVisible = false };
        private readonly Grid _scrim = new();
        private readonly ContentControl _panel = new() { IsTabStop = true, VerticalAlignment = VerticalAlignment.Stretch };
        private readonly Grid _panelSlot = new();

        public MuiDrawerShell()
        {
            _panel.Content = _panelSlot;
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

            ApplyPanelWidth();
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

        private void ApplyPanelWidth() => _panel.Width = PanelWidth;

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

        private void Rebuild()
        {
            _scrim.Background = new SolidColorBrush(Windows.UI.Color.FromArgb(0x73, 0, 0, 0));
            _panel.Background = R("MapleSidebar");
            _panel.HorizontalAlignment = Edge == MuiDrawerShellEdge.Right ? HorizontalAlignment.Right : HorizontalAlignment.Left;

            _panelSlot.Children.Clear();
            if (PanelContent is not null) _panelSlot.Children.Add(PanelContent);
        }
    }
}
