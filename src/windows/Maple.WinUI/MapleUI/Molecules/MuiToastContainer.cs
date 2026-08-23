using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One toast entry hosted by a Toast Container.</summary>
    public sealed record MuiToastEntry(
        string Id, MuiToastVariant Variant, string Message, string? ActionLabel = null, int? AutoDismissMs = null);

    /// <summary>Toast Container corner/edge (unified-component-catalog.md
    /// §2.3, "Toast Container" row).</summary>
    public enum MuiToastContainerPosition { TopRight, BottomRight, BottomCenter }

    /// <summary>
    /// Maple.UI Toast Container molecule (unified-component-catalog.md
    /// §2.3, "Toast Container" row: "Stacks and positions toasts", built
    /// from Toast) — hosts a live stack of <see cref="MuiToast"/> atoms.
    ///
    /// Ports `mui-toast-container.component.ts`: <see cref="ExitStaggerMs"/>
    /// is a small per-index delay so a bulk <see cref="DismissAll"/> cascades
    /// rather than every toast vanishing on the same frame.
    /// <see cref="Inline"/> switches between overlay placement (pinned to
    /// one corner/edge of whatever positioned ancestor hosts this control —
    /// the usual whole-app toast stack) and normal in-flow layout (a toast
    /// stack scoped to one panel).
    /// </summary>
    public sealed class MuiToastContainer : ContentControl
    {
        public const int ExitStaggerMs = 60;

        public static readonly DependencyProperty ToastsProperty =
            DependencyProperty.Register(nameof(Toasts), typeof(IReadOnlyList<MuiToastEntry>), typeof(MuiToastContainer),
                new PropertyMetadata(null, (d, _) => ((MuiToastContainer)d).Rebuild()));

        public static readonly DependencyProperty PositionProperty =
            DependencyProperty.Register(nameof(Position), typeof(MuiToastContainerPosition), typeof(MuiToastContainer),
                new PropertyMetadata(MuiToastContainerPosition.BottomRight, (d, _) => ((MuiToastContainer)d).Rebuild()));

        public static readonly DependencyProperty InlineProperty =
            DependencyProperty.Register(nameof(Inline), typeof(bool), typeof(MuiToastContainer),
                new PropertyMetadata(false, (d, _) => ((MuiToastContainer)d).Rebuild()));

        public IReadOnlyList<MuiToastEntry>? Toasts
        {
            get => (IReadOnlyList<MuiToastEntry>?)GetValue(ToastsProperty);
            set => SetValue(ToastsProperty, value);
        }

        public MuiToastContainerPosition Position
        {
            get => (MuiToastContainerPosition)GetValue(PositionProperty);
            set => SetValue(PositionProperty, value);
        }

        /// <summary>Lays out in normal flow instead of pinning to a corner
        /// of the nearest positioned ancestor.</summary>
        public bool Inline
        {
            get => (bool)GetValue(InlineProperty);
            set => SetValue(InlineProperty, value);
        }

        /// <summary>Fires with the toast's id when its action button is pressed.</summary>
        public event EventHandler<string>? ActionPressed;

        /// <summary>Fires with the toast's id once its exit fade completes —
        /// the host should remove it from <see cref="Toasts"/> now.</summary>
        public event EventHandler<string>? Dismissed;

        private readonly StackPanel _stack = new() { Orientation = Orientation.Vertical, Spacing = 8 };
        private readonly Dictionary<string, MuiToast> _liveToasts = new();

        public MuiToastContainer()
        {
            Content = _stack;
            IsTabStop = false;
            Rebuild();
        }

        /// <summary>Dismisses every live toast with a small per-index delay
        /// (<see cref="ExitStaggerMs"/>) so a bulk dismissal cascades rather
        /// than vanishing on the same frame.</summary>
        public void DismissAll()
        {
            var index = 0;
            foreach (var toast in _liveToasts.Values)
            {
                var delayMs = index * ExitStaggerMs;
                var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(Math.Max(1, delayMs)) };
                timer.Tick += (_, _) => { timer.Stop(); toast.Dismiss(); };
                timer.Start();
                index++;
            }
        }

        private void Rebuild()
        {
            _stack.Children.Clear();
            _liveToasts.Clear();

            switch (Position)
            {
                case MuiToastContainerPosition.TopRight:
                    HorizontalAlignment = HorizontalAlignment.Right;
                    VerticalAlignment = VerticalAlignment.Top;
                    break;
                case MuiToastContainerPosition.BottomCenter:
                    HorizontalAlignment = HorizontalAlignment.Center;
                    VerticalAlignment = VerticalAlignment.Bottom;
                    break;
                default:
                    HorizontalAlignment = HorizontalAlignment.Right;
                    VerticalAlignment = VerticalAlignment.Bottom;
                    break;
            }
            if (Inline)
            {
                HorizontalAlignment = HorizontalAlignment.Stretch;
                VerticalAlignment = VerticalAlignment.Top;
            }

            foreach (var entry in Toasts ?? Array.Empty<MuiToastEntry>())
            {
                var toast = new MuiToast
                {
                    Variant = entry.Variant,
                    Message = entry.Message,
                    ActionLabel = entry.ActionLabel,
                    AutoDismissMs = entry.AutoDismissMs,
                };
                var id = entry.Id;
                toast.ActionRequested += (_, _) => ActionPressed?.Invoke(this, id);
                toast.Dismissed += (_, _) => Dismissed?.Invoke(this, id);
                _liveToasts[id] = toast;
                _stack.Children.Add(toast);
            }
        }
    }
}
