using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>List marker style (list.md § Props). Ignored when
    /// <see cref="MuiList.Ordered"/> is set.</summary>
    public enum MuiListMarker { Disc, Dash, None }

    /// <summary>List item density (list.md § Props).</summary>
    public enum MuiListDensity { Compact, Comfortable }

    /// <summary>One list.md node: text plus optional nested children — the
    /// same recursive shape the contract's `items` prop specifies.</summary>
    public sealed record MuiListItem(string Text, IReadOnlyList<MuiListItem>? Children = null);

    /// <summary>
    /// Maple.UI List atom (docs/design/maple-ui/components/list.md) — the
    /// plain-text list primitive underneath a bulleted description or a
    /// numbered set of steps.
    ///
    /// NOT a native ul/ol + li tree: WinUI has no bare list-semantics
    /// primitive short of ListView (a selection-oriented control the wrong
    /// shape for this atom — see list.md's own distinction from the List Row
    /// molecule). Rows render as plain TextBlocks in a StackPanel, so
    /// Narrator announces each item's text but not "list of N items"
    /// list-role semantics the way a real &lt;ul&gt;/&lt;li&gt; tree would —
    /// a known platform gap, not a missed requirement.
    /// </summary>
    public sealed class MuiList : ContentControl
    {
        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IEnumerable<MuiListItem>), typeof(MuiList),
                new PropertyMetadata(null, (d, _) => ((MuiList)d).Rebuild()));

        public static readonly DependencyProperty OrderedProperty =
            DependencyProperty.Register(nameof(Ordered), typeof(bool), typeof(MuiList),
                new PropertyMetadata(false, (d, _) => ((MuiList)d).Rebuild()));

        public static readonly DependencyProperty MarkerProperty =
            DependencyProperty.Register(nameof(Marker), typeof(MuiListMarker), typeof(MuiList),
                new PropertyMetadata(MuiListMarker.Disc, (d, _) => ((MuiList)d).Rebuild()));

        public static readonly DependencyProperty DensityProperty =
            DependencyProperty.Register(nameof(Density), typeof(MuiListDensity), typeof(MuiList),
                new PropertyMetadata(MuiListDensity.Comfortable, (d, _) => ((MuiList)d).Rebuild()));

        /// <summary>Required. Unbounded nesting via each item's Children.</summary>
        public IEnumerable<MuiListItem>? Items
        {
            get => (IEnumerable<MuiListItem>?)GetValue(ItemsProperty);
            set => SetValue(ItemsProperty, value);
        }

        /// <summary>Numbers ("1.", "2.", ...) instead of a bullet marker.</summary>
        public bool Ordered
        {
            get => (bool)GetValue(OrderedProperty);
            set => SetValue(OrderedProperty, value);
        }

        public MuiListMarker Marker
        {
            get => (MuiListMarker)GetValue(MarkerProperty);
            set => SetValue(MarkerProperty, value);
        }

        public MuiListDensity Density
        {
            get => (MuiListDensity)GetValue(DensityProperty);
            set => SetValue(DensityProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical };

        public MuiList()
        {
            Content = _root;
            IsTabStop = false;
            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _root.Children.Clear();
            _root.Spacing = Density == MuiListDensity.Compact ? 4 : 8;

            if (Items is { } items)
                BuildRows(items, depth: 0);
        }

        private void BuildRows(IEnumerable<MuiListItem> items, int depth)
        {
            var index = 1;
            foreach (var item in items)
            {
                var row = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    Spacing = 6,
                    Margin = new Thickness(depth * 16, 0, 0, 0),
                };

                var markerText = Ordered
                    ? $"{index}."
                    : Marker switch
                    {
                        MuiListMarker.Dash => "–",
                        MuiListMarker.None => string.Empty,
                        _ => "•",
                    };
                var marker = new TextBlock
                {
                    FontSize = 13,
                    Text = markerText,
                    Foreground = R(!Ordered && Marker == MuiListMarker.Dash ? "MapleTextMuted" : "MapleTextMain"),
                    Visibility = string.IsNullOrEmpty(markerText) ? Visibility.Collapsed : Visibility.Visible,
                };
                var text = new TextBlock
                {
                    FontSize = 13,
                    Text = item.Text,
                    Foreground = R("MapleTextMain"),
                    TextWrapping = TextWrapping.Wrap,
                };
                row.Children.Add(marker);
                row.Children.Add(text);
                _root.Children.Add(row);

                if (item.Children is { Count: > 0 } children)
                    BuildRows(children, depth + 1);

                index++;
            }
        }
    }
}
