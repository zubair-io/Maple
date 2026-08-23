using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Windows.System;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Sheet Shell template (unified-component-catalog.md §5,
    /// "Sheet Shell" row: "Scrim · Grab handle · Body", regions only) — the
    /// design-system generalization of a phone-tier bottom sheet. Ports
    /// `mui-sheet-shell.component.ts`'s contract: <see cref="Detents"/>
    /// are fractions (0-1] of the container height,
    /// <see cref="ActiveDetent"/> is an index into that array. Dragging
    /// the grab handle only ever dismisses (matches the web port's pan-down
    /// gesture) — it does not cycle detents, a deliberately separate
    /// concern from the dismiss threshold this control owns.
    ///
    /// Drag math (pan-down clamp, dismiss-distance threshold, detent →
    /// height-fraction) lives in <see cref="MuiSheetShellDragLogic"/> —
    /// plain C#, unit-tested without a live Window. Motion is a live
    /// <see cref="TranslateTransform"/> follow during drag, then either
    /// dismissal or a <see cref="Storyboard"/> spring-back animation on
    /// release — same "hand off to a live transform during drag, animate
    /// only at rest" shape <see cref="MuiTabs"/>'s indicator already uses
    /// in this library.
    ///
    /// <see cref="Contained"/> reuses <see cref="MuiDialog"/>'s
    /// Popup-vs-inline approach — see <see cref="MuiOverlayShell"/>'s own
    /// doc comment for the shared rationale.
    /// </summary>
    public sealed class MuiSheetShell : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiSheetShell),
                new PropertyMetadata(false, (d, _) => ((MuiSheetShell)d).ApplyOpenState()));

        public static readonly DependencyProperty DetentsProperty =
            DependencyProperty.Register(nameof(Detents), typeof(IReadOnlyList<double>), typeof(MuiSheetShell),
                new PropertyMetadata(MuiSheetShellDragLogic.DefaultDetents, (d, _) => ((MuiSheetShell)d).ApplyHeightFraction()));

        public static readonly DependencyProperty ActiveDetentProperty =
            DependencyProperty.Register(nameof(ActiveDetent), typeof(int), typeof(MuiSheetShell),
                new PropertyMetadata(0, (d, _) => ((MuiSheetShell)d).ApplyHeightFraction()));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiSheetShell),
                new PropertyMetadata(false, (d, _) => ((MuiSheetShell)d).ApplyOpenState()));

        public static readonly DependencyProperty BodyProperty =
            DependencyProperty.Register(nameof(Body), typeof(UIElement), typeof(MuiSheetShell),
                new PropertyMetadata(null, (d, _) => ((MuiSheetShell)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public IReadOnlyList<double> Detents { get => (IReadOnlyList<double>)GetValue(DetentsProperty); set => SetValue(DetentsProperty, value); }
        public int ActiveDetent { get => (int)GetValue(ActiveDetentProperty); set => SetValue(ActiveDetentProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }

        /// <summary>The default (un-named) region.</summary>
        public UIElement? Body { get => (UIElement?)GetValue(BodyProperty); set => SetValue(BodyProperty, value); }

        /// <summary>Fires on Escape, a scrim click, or a drag past the
        /// dismiss threshold. Does NOT set <see cref="IsOpen"/> false
        /// itself — same contract as <see cref="MuiDialog"/>'s own
        /// <c>Dismissed</c> event.</summary>
        public event EventHandler? Dismissed;

        private readonly Popup _popup = new() { IsLightDismissEnabled = false };
        private readonly Grid _inlineHost = new() { IsHitTestVisible = false };
        private readonly Grid _scrim = new();
        private readonly ContentControl _sheet = new()
        {
            IsTabStop = true,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Bottom,
            CornerRadius = new CornerRadius(16, 16, 0, 0),
        };
        private readonly StackPanel _sheetBody = new() { Orientation = Orientation.Vertical, Spacing = 0 };
        private readonly Border _dragArea = new() { Height = 30, HorizontalAlignment = HorizontalAlignment.Stretch };
        private readonly Border _grabHandle = new()
        {
            Width = 38,
            Height = 4,
            CornerRadius = new CornerRadius(2),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 10, 0, 0),
        };
        private readonly ScrollViewer _bodyScroll = new();
        private readonly Grid _bodySlot = new();
        private readonly TranslateTransform _dragTransform = new();

        private uint? _pointerId;
        private double _dragStartY;
        private double _scrimHeight;

        public MuiSheetShell()
        {
            _dragArea.Child = _grabHandle;
            _bodyScroll.Content = _bodySlot;
            _sheetBody.Children.Add(_dragArea);
            _sheetBody.Children.Add(_bodyScroll);
            _sheet.Content = _sheetBody;
            _sheet.RenderTransform = _dragTransform;
            _scrim.Children.Add(_sheet);
            _scrim.HorizontalAlignment = HorizontalAlignment.Stretch;
            _scrim.VerticalAlignment = VerticalAlignment.Stretch;

            Content = _inlineHost;
            IsTabStop = false;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;
            Visibility = Visibility.Collapsed;

            _scrim.Tapped += (_, _) => Dismiss();
            _sheet.Tapped += (_, e) => e.Handled = true;
            _sheet.KeyDown += OnSheetKeyDown;
            _scrim.SizeChanged += (_, e) => { _scrimHeight = e.NewSize.Height; ApplyHeightFraction(); };

            _dragArea.PointerPressed += OnDragPointerPressed;
            _dragArea.PointerMoved += OnDragPointerMoved;
            _dragArea.PointerReleased += OnDragPointerReleased;
            _dragArea.PointerCanceled += OnDragPointerReleased;
            _dragArea.PointerCaptureLost += (_, _) => { _pointerId = null; AnimateBackToRest(); };

            Rebuild();
            ApplyOpenState();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnSheetKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key != VirtualKey.Escape) return;
            e.Handled = true;
            Dismiss();
        }

        private void Dismiss() => Dismissed?.Invoke(this, EventArgs.Empty);

        private void OnDragPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!e.GetCurrentPoint(_dragArea).Properties.IsLeftButtonPressed) return;
            _pointerId = e.Pointer.PointerId;
            _dragStartY = e.GetCurrentPoint(this).Position.Y;
            _dragTransform.Y = 0;
            _dragArea.CapturePointer(e.Pointer);
            e.Handled = true;
        }

        private void OnDragPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_pointerId != e.Pointer.PointerId) return;
            var y = e.GetCurrentPoint(this).Position.Y;
            _dragTransform.Y = MuiSheetShellDragLogic.ClampPanDown(y - _dragStartY);
            e.Handled = true;
        }

        private void OnDragPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (_pointerId != e.Pointer.PointerId) return;
            _pointerId = null;
            _dragArea.ReleasePointerCapture(e.Pointer);

            var dy = _dragTransform.Y;
            var dismissed = MuiSheetShellDragLogic.IsDistanceDismissed(dy, _sheet.ActualHeight, MuiSheetShellDragLogic.DismissFraction);
            if (dismissed)
                Dismiss(); // caller-driven IsOpen = false already resets the transform via ApplyOpenState — no spring-back needed.
            else
                AnimateBackToRest();
            e.Handled = true;
        }

        private void AnimateBackToRest()
        {
            var anim = new DoubleAnimation
            {
                From = _dragTransform.Y,
                To = 0,
                Duration = new Duration(TimeSpan.FromMilliseconds(200)),
                EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
            };
            Storyboard.SetTarget(anim, _dragTransform);
            Storyboard.SetTargetProperty(anim, "Y");
            var storyboard = new Storyboard();
            storyboard.Children.Add(anim);
            storyboard.Begin();
        }

        private void ApplyOpenState()
        {
            _popup.IsOpen = false;
            if (_popup.XamlRoot != null) _popup.XamlRoot.Changed -= OnXamlRootChanged;
            _popup.Child = null;
            _inlineHost.Children.Clear();
            _dragTransform.Y = 0;

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

            ApplyHeightFraction();
            DispatcherQueue.TryEnqueue(() => _ = FocusManager.TryFocusAsync(_sheet, FocusState.Programmatic));
        }

        private void OnXamlRootChanged(XamlRoot sender, XamlRootChangedEventArgs args) => ResizeScrim();

        private void ResizeScrim()
        {
            if (XamlRoot is null) return;
            _scrim.Width = XamlRoot.Size.Width;
            _scrim.Height = XamlRoot.Size.Height;
            _scrimHeight = XamlRoot.Size.Height;
        }

        private void ApplyHeightFraction()
        {
            var fraction = MuiSheetShellDragLogic.HeightFraction(Detents, ActiveDetent);
            _sheet.Height = _scrimHeight > 0 ? _scrimHeight * fraction : double.NaN;
        }

        private void Rebuild()
        {
            _scrim.Background = new SolidColorBrush(Windows.UI.Color.FromArgb(0x59, 0, 0, 0));
            _sheet.Background = R("MapleSurface");
            _grabHandle.Background = R("MapleBorderHi");

            _bodySlot.Children.Clear();
            if (Body is not null) _bodySlot.Children.Add(Body);

            ApplyHeightFraction();
        }
    }
}
