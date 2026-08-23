using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Pick/reject flag state (mirrors the Lightroom-style culling
    /// flag: none, pick, reject).</summary>
    public enum MuiRatingFlagState { None, Pick, Reject }

    /// <summary>
    /// Maple.UI Rating &amp; Flags molecule (unified-component-catalog.md
    /// §2.2, "Rating &amp; Flags" row: "Star rating plus pick/reject", built
    /// from Icon, Badge) — the classic Lightroom culling pattern: click a
    /// star to set the rating (click the current top star again to clear
    /// it); a separate flag glyph cycles none → pick → reject → none.
    ///
    /// Ports `mui-rating-flags.component.ts`'s `setRating`/`cycleFlag`
    /// logic exactly (both trivial enough not to warrant a separate math
    /// class the way Slider/DragBar/ColorWheel/Pad2D do — the whole
    /// "click the current top star clears it" rule is the one line
    /// `setRating` below). Keyboard (Left/Right/Up/Down adjusting the
    /// rating by one) lives on the control root, matching the web
    /// molecule's single `onKeydown` handler rather than per-star roving
    /// focus.
    /// </summary>
    public sealed class MuiRatingFlags : ContentControl
    {
        public static readonly DependencyProperty RatingProperty =
            DependencyProperty.Register(nameof(Rating), typeof(int), typeof(MuiRatingFlags),
                new PropertyMetadata(0, (d, _) => ((MuiRatingFlags)d).Rebuild()));

        public static readonly DependencyProperty MaxProperty =
            DependencyProperty.Register(nameof(Max), typeof(int), typeof(MuiRatingFlags),
                new PropertyMetadata(5, (d, _) => ((MuiRatingFlags)d).RebuildStars()));

        public static readonly DependencyProperty FlagProperty =
            DependencyProperty.Register(nameof(Flag), typeof(MuiRatingFlagState), typeof(MuiRatingFlags),
                new PropertyMetadata(MuiRatingFlagState.None, (d, _) => ((MuiRatingFlags)d).Rebuild()));

        public int Rating
        {
            get => (int)GetValue(RatingProperty);
            set => SetValue(RatingProperty, value);
        }

        public int Max
        {
            get => (int)GetValue(MaxProperty);
            set => SetValue(MaxProperty, value);
        }

        public MuiRatingFlagState Flag
        {
            get => (MuiRatingFlagState)GetValue(FlagProperty);
            set => SetValue(FlagProperty, value);
        }

        public event EventHandler<int>? RatingChanged;
        public event EventHandler<MuiRatingFlagState>? FlagChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 10 };
        private readonly StackPanel _starRow = new() { Orientation = Orientation.Horizontal, Spacing = 2 };
        private readonly Border _flagHit = new() { Padding = new Thickness(2) };
        private readonly MuiIcon _flagIcon = new() { IconName = "flag", Size = MuiIconSize.Sm16 };

        public MuiRatingFlags()
        {
            _flagHit.Child = _flagIcon;
            _root.Children.Add(_starRow);
            _root.Children.Add(_flagHit);
            Content = _root;
            IsTabStop = true;

            _flagHit.Tapped += (_, _) => CycleFlag();
            KeyDown += OnKeyDown;
            IsEnabledChanged += (_, _) => Rebuild();

            RebuildStars();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void SetRating(int star)
        {
            if (!IsEnabled) return;
            var next = star == Rating ? star - 1 : star;
            Rating = next;
            RatingChanged?.Invoke(this, next);
        }

        private void CycleFlag()
        {
            if (!IsEnabled) return;
            var next = Flag switch
            {
                MuiRatingFlagState.None => MuiRatingFlagState.Pick,
                MuiRatingFlagState.Pick => MuiRatingFlagState.Reject,
                _ => MuiRatingFlagState.None,
            };
            Flag = next;
            FlagChanged?.Invoke(this, next);
        }

        private void OnKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (!IsEnabled) return;
            int? next = e.Key switch
            {
                Windows.System.VirtualKey.Right or Windows.System.VirtualKey.Up => Math.Min(Max, Rating + 1),
                Windows.System.VirtualKey.Left or Windows.System.VirtualKey.Down => Math.Max(0, Rating - 1),
                _ => null,
            };
            if (next is not { } value) return;
            e.Handled = true;
            Rating = value;
            RatingChanged?.Invoke(this, value);
        }

        private void RebuildStars()
        {
            _starRow.Children.Clear();
            for (var i = 1; i <= Math.Max(0, Max); i++)
            {
                var star = i;
                var hit = new Border { Padding = new Thickness(1) };
                var icon = new MuiIcon { Size = MuiIconSize.Sm16 };
                hit.Child = icon;
                hit.Tapped += (_, _) => SetRating(star);
                hit.Tag = icon;
                _starRow.Children.Add(hit);
            }
            Rebuild();
        }

        private void Rebuild()
        {
            for (var i = 0; i < _starRow.Children.Count; i++)
            {
                if (_starRow.Children[i] is not Border hit || hit.Tag is not MuiIcon icon) continue;
                var filled = i + 1 <= Rating;
                icon.IconName = filled ? "star-filled" : "star";
                icon.IconColor = filled ? R("MapleStar") : R("MapleTextMuted");
            }

            _flagIcon.IconColor = Flag switch
            {
                MuiRatingFlagState.Pick => R("MapleSuccessText"),
                MuiRatingFlagState.Reject => R("MapleErrorText"),
                _ => R("MapleTextMuted"),
            };

            Opacity = IsEnabled ? 1.0 : 0.45;

            var flagName = Flag switch
            {
                MuiRatingFlagState.Pick => "picked",
                MuiRatingFlagState.Reject => "rejected",
                _ => "no flag",
            };
            AutomationProperties.SetName(this, $"Rating {Rating} of {Max}, {flagName}");
        }
    }
}
