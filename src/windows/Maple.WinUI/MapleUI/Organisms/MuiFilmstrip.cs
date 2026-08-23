using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Filmstrip organism (unified-component-catalog.md §4.1,
    /// "Filmstrip" row: "Focus-following thumbnail strip", built from
    /// Filmstrip Row, Filmstrip Rail) — a thin switcher between the two
    /// molecules that already do the actual work: <see cref="MuiFilmstripRow"/>
    /// (a wide bottom strip) when <see cref="IsCollapsed"/> is false, and
    /// <see cref="MuiFilmstripRail"/> (a narrow side rail with its own
    /// collapse chevron) when true. "Focus-following" — the active item
    /// scrolling into view as it changes — is each molecule's own
    /// <c>MuiFilmstripFollowLogic</c>; this organism only forwards
    /// <see cref="Items"/>/<see cref="ActiveId"/> to whichever one is
    /// visible.
    /// </summary>
    public sealed class MuiFilmstrip : ContentControl
    {
        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IReadOnlyList<MuiFilmstripItem>), typeof(MuiFilmstrip),
                new PropertyMetadata(null, (d, _) => ((MuiFilmstrip)d).Rebuild()));

        public static readonly DependencyProperty ActiveIdProperty =
            DependencyProperty.Register(nameof(ActiveId), typeof(string), typeof(MuiFilmstrip),
                new PropertyMetadata(null, (d, _) => ((MuiFilmstrip)d).Rebuild()));

        public static readonly DependencyProperty IsCollapsedProperty =
            DependencyProperty.Register(nameof(IsCollapsed), typeof(bool), typeof(MuiFilmstrip),
                new PropertyMetadata(false, (d, _) => ((MuiFilmstrip)d).Rebuild()));

        public IReadOnlyList<MuiFilmstripItem>? Items
        {
            get => (IReadOnlyList<MuiFilmstripItem>?)GetValue(ItemsProperty);
            set => SetValue(ItemsProperty, value);
        }

        public string? ActiveId
        {
            get => (string?)GetValue(ActiveIdProperty);
            set => SetValue(ActiveIdProperty, value);
        }

        /// <summary>True renders the narrow <see cref="MuiFilmstripRail"/>
        /// instead of the wide <see cref="MuiFilmstripRow"/> — e.g. a
        /// tall/narrow detail-pane host.</summary>
        public bool IsCollapsed
        {
            get => (bool)GetValue(IsCollapsedProperty);
            set => SetValue(IsCollapsedProperty, value);
        }

        public event EventHandler<string>? Activated;

        private readonly MuiFilmstripRow _row = new();
        private readonly MuiFilmstripRail _rail = new();

        public MuiFilmstrip()
        {
            _row.Activated += (_, id) => Activated?.Invoke(this, id);
            _rail.Activated += (_, id) => Activated?.Invoke(this, id);
            Rebuild();
        }

        private void Rebuild()
        {
            _row.Items = Items;
            _row.ActiveId = ActiveId;
            _rail.Items = Items;
            _rail.ActiveId = ActiveId;
            Content = IsCollapsed ? _rail : _row;
        }
    }
}
