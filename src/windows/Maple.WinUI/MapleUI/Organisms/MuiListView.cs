using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One row in a List View.</summary>
    public sealed record MuiListViewItem(string Id, string Label, string? IconName = null, UIElement? TrailingContent = null);

    /// <summary>
    /// Maple.UI List View organism (unified-component-catalog.md §4.1,
    /// "List View" row: "Virtualized row list", built from List Row, Empty
    /// State, Spinner). Not virtualized, for the same "simplest
    /// compile-safe option" reasoning <see cref="MuiCollectionGrid"/>'s
    /// class doc comment gives — a plain vertical stack of
    /// <see cref="MuiListRow"/>s inside a ScrollViewer.
    ///
    /// Shares <see cref="MuiCollectionGrid"/>'s click/Ctrl-click/
    /// Shift-click selection semantics via the same
    /// <see cref="MuiCollectionGridSelection"/> state machine (it's a
    /// plain ordered-id operation, nothing grid-specific about it).
    /// </summary>
    public sealed class MuiListView : ContentControl
    {
        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IReadOnlyList<MuiListViewItem>), typeof(MuiListView),
                new PropertyMetadata(null, (d, _) => ((MuiListView)d).Rebuild()));

        public static readonly DependencyProperty SelectedIdsProperty =
            DependencyProperty.Register(nameof(SelectedIds), typeof(IReadOnlyList<string>), typeof(MuiListView),
                new PropertyMetadata(null, (d, _) => ((MuiListView)d).RebuildSelectionVisuals()));

        public static readonly DependencyProperty IsLoadingProperty =
            DependencyProperty.Register(nameof(IsLoading), typeof(bool), typeof(MuiListView),
                new PropertyMetadata(false, (d, _) => ((MuiListView)d).Rebuild()));

        public static readonly DependencyProperty EmptyTitleProperty =
            DependencyProperty.Register(nameof(EmptyTitle), typeof(string), typeof(MuiListView),
                new PropertyMetadata("Nothing here yet", (d, _) => ((MuiListView)d).Rebuild()));

        public IReadOnlyList<MuiListViewItem>? Items
        {
            get => (IReadOnlyList<MuiListViewItem>?)GetValue(ItemsProperty);
            set => SetValue(ItemsProperty, value);
        }

        public IReadOnlyList<string>? SelectedIds
        {
            get => (IReadOnlyList<string>?)GetValue(SelectedIdsProperty);
            set => SetValue(SelectedIdsProperty, value);
        }

        public bool IsLoading
        {
            get => (bool)GetValue(IsLoadingProperty);
            set => SetValue(IsLoadingProperty, value);
        }

        public string EmptyTitle
        {
            get => (string)GetValue(EmptyTitleProperty);
            set => SetValue(EmptyTitleProperty, value);
        }

        public event EventHandler<IReadOnlyList<string>>? SelectionChanged;

        private readonly Grid _host = new();
        private readonly ScrollViewer _scroll = new();
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly MuiEmptyState _empty = new() { IconName = "sidebar" };
        private readonly MuiSpinner _spinner = new() { IsSpinning = true, SpinnerSize = MuiSpinnerSize.Md, DelayMs = 0, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        private readonly Dictionary<string, MuiListRow> _rowControls = new();
        private string? _anchorId;

        public MuiListView()
        {
            _scroll.Content = _rows;
            _host.Children.Add(_scroll);
            _host.Children.Add(_empty);
            _host.Children.Add(_spinner);
            Content = _host;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;
            Rebuild();
        }

        private void Rebuild()
        {
            var items = Items ?? Array.Empty<MuiListViewItem>();
            _empty.Visibility = !IsLoading && items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _empty.Title = EmptyTitle;
            _spinner.Visibility = IsLoading && items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _scroll.Visibility = items.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _rows.Children.Clear();
            _rowControls.Clear();
            foreach (var item in items)
            {
                var row = new MuiListRow
                {
                    Label = item.Label,
                    IconName = item.IconName,
                    TrailingContent = item.TrailingContent,
                };
                row.Pressed += (_, _) => Select(item.Id, MuiPointerModifierReader.CurrentModifier());
                _rowControls[item.Id] = row;
                _rows.Children.Add(row);
            }
            RebuildSelectionVisuals();
        }

        private void RebuildSelectionVisuals()
        {
            var selected = SelectedIds is null ? new HashSet<string>() : new HashSet<string>(SelectedIds);
            foreach (var (id, row) in _rowControls)
                row.Active = selected.Contains(id);
        }

        private void Select(string id, MuiSelectionModifier modifier)
        {
            var orderedIds = (Items ?? Array.Empty<MuiListViewItem>()).Select(i => i.Id).ToList();
            var current = SelectedIds is null ? new HashSet<string>() : new HashSet<string>(SelectedIds);
            var next = MuiCollectionGridSelection.Apply(orderedIds, current, _anchorId, id, modifier);
            _anchorId = MuiCollectionGridSelection.NextAnchor(_anchorId, id, modifier);
            SelectionChanged?.Invoke(this, next.ToList());
        }
    }
}
