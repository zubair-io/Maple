using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;
using Windows.System;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Popover molecule (unified-component-catalog.md §2.4,
    /// "Popover" row: "Anchored floating container", built from _(none —
    /// positioning primitive)_) — every overlay menu (Context/Suggestion/
    /// Command/Bubble Menu, Toolbar's overflow) composes this.
    ///
    /// Ports `mui-popover.component.ts`'s contract, adapted to a native
    /// WinUI <see cref="Popup"/> instead of hand-rolled document
    /// click/Escape listeners: the web component has NO trigger slot of its
    /// own — its template renders only the floating panel, anchored via CSS
    /// `position: absolute` against whatever `position: relative` ancestor
    /// the CALLER wraps both the trigger and the popover in. This control
    /// mirrors that shape exactly rather than trying to own the trigger
    /// visual itself: it renders nothing inline (zero hit-test surface,
    /// <see cref="HorizontalAlignment.Stretch"/>/<see cref="VerticalAlignment.Stretch"/>
    /// by default) and expects the caller to place it as a sibling of the
    /// trigger element inside the same Grid cell — the WinUI equivalent of
    /// the web's "position: relative box" — so its own layout rect at open
    /// time IS the anchor rect <see cref="MuiPopoverMath.ComputeOffset"/>
    /// positions against.
    ///
    /// Outside-click dismiss and initial focus containment come from the
    /// platform for free via <see cref="Popup.IsLightDismissEnabled"/>
    /// (WinUI's native equivalent of the web's manual `document` click
    /// listener) rather than reimplementing that plumbing; Escape is
    /// handled explicitly on the panel host since light-dismiss alone
    /// doesn't bind it. "Keep conservative" per this wave's brief: no
    /// off-screen viewport clamping is wired up yet (the pure math for it
    /// exists in <see cref="MuiPopoverMath.ClampToViewport"/> for a later
    /// wave to call once real anchor geometry can be checked against a
    /// live window at the wave's build/CI conditions), and this control
    /// carries no Content property of its own — see the doc comment above.
    /// </summary>
    public sealed class MuiPopover : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiPopover),
                new PropertyMetadata(false, (d, _) => ((MuiPopover)d).ApplyOpenState()));

        public static readonly DependencyProperty PlacementProperty =
            DependencyProperty.Register(nameof(Placement), typeof(MuiPopoverPlacement), typeof(MuiPopover),
                new PropertyMetadata(MuiPopoverPlacement.Bottom, (d, _) => ((MuiPopover)d).Reposition()));

        public static readonly DependencyProperty PanelContentProperty =
            DependencyProperty.Register(nameof(PanelContent), typeof(object), typeof(MuiPopover),
                new PropertyMetadata(null, (d, e) => ((MuiPopover)d)._panelHost.Content = e.NewValue));

        public bool IsOpen
        {
            get => (bool)GetValue(IsOpenProperty);
            set => SetValue(IsOpenProperty, value);
        }

        public MuiPopoverPlacement Placement
        {
            get => (MuiPopoverPlacement)GetValue(PlacementProperty);
            set => SetValue(PlacementProperty, value);
        }

        /// <summary>What renders inside the floating panel.</summary>
        public object? PanelContent
        {
            get => GetValue(PanelContentProperty);
            set => SetValue(PanelContentProperty, value);
        }

        /// <summary>Fires on an outside click (light-dismiss) or Escape —
        /// the caller owns <see cref="IsOpen"/> and is expected to flip it
        /// false in response, same contract as the web component.</summary>
        public event EventHandler? CloseRequested;

        private readonly Popup _popup = new() { IsLightDismissEnabled = true };
        private readonly ContentControl _panelHost = new()
        {
            IsTabStop = true,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(6),
            MinWidth = 160,
        };

        public MuiPopover()
        {
            // Zero visible/hit-testable surface of its own — see the class
            // doc comment. Stretch so a caller placing this alongside a
            // trigger in the same Grid cell gets this control's layout rect
            // matching the trigger's bounds for free.
            HorizontalAlignment = HorizontalAlignment.Stretch;
            VerticalAlignment = VerticalAlignment.Stretch;
            IsHitTestVisible = false;
            IsTabStop = false;
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);

            _popup.Child = _panelHost;
            _popup.Closed += (_, _) =>
            {
                CloseRequested?.Invoke(this, EventArgs.Empty);
            };

            _panelHost.KeyDown += OnPanelKeyDown;
            _panelHost.SizeChanged += (_, _) => Reposition();
            SizeChanged += (_, _) => Reposition();

            Rebuild();
        }

        private void OnPanelKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key != VirtualKey.Escape) return;
            e.Handled = true;
            CloseRequested?.Invoke(this, EventArgs.Empty);
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _panelHost.Background = R("MapleSurface");
            _panelHost.BorderBrush = R("MapleBorder");
            _panelHost.Foreground = R("MapleTextMain");
        }

        private void ApplyOpenState()
        {
            if (IsOpen)
            {
                if (XamlRoot != null) _popup.XamlRoot = XamlRoot;
                _popup.IsOpen = true;
                Reposition();
                DispatcherQueue.TryEnqueue(() =>
                {
                    Reposition();
                    _panelHost.Focus(FocusState.Programmatic);
                });
            }
            else
            {
                _popup.IsOpen = false;
            }
        }

        private void Reposition()
        {
            if (!_popup.IsOpen || XamlRoot is null) return;

            var anchor = TransformToVisual(null).TransformPoint(new Point(0, 0));
            var panelWidth = _panelHost.ActualWidth > 0 ? _panelHost.ActualWidth : _panelHost.DesiredSize.Width;
            var panelHeight = _panelHost.ActualHeight > 0 ? _panelHost.ActualHeight : _panelHost.DesiredSize.Height;

            var (x, y) = MuiPopoverMath.ComputeOffset(
                anchor.X, anchor.Y, ActualWidth, ActualHeight, panelWidth, panelHeight, Placement);

            _popup.HorizontalOffset = x;
            _popup.VerticalOffset = y;
        }
    }
}
