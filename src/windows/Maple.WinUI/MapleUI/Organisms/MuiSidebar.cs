using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Sidebar organism (unified-component-catalog.md §4.2,
    /// "Sidebar" row: "Hierarchical source / page tree", built from Tree
    /// Row, Toolbar, Collapsible, Context Menu, Empty State) — an optional
    /// top <see cref="MuiToolbar"/> (e.g. "New Album"/"Import"), then one
    /// <see cref="MuiTreeRow"/> per <see cref="MuiSidebarFlatten"/> row,
    /// or a <see cref="MuiEmptyState"/> when the tree is empty. Expansion
    /// state lives inside this control (a plain UI-only concern, not
    /// caller-owned data); <see cref="ActiveId"/> and item activation are
    /// controlled the same way every other organism in this wave is.
    /// Right-click opens a per-row <see cref="MuiContextMenu"/>, anchored
    /// the same "trigger and popover share a Grid cell" way
    /// MuiGalleryWindow's own AnchoredDemo helper documents.
    /// </summary>
    public sealed class MuiSidebar : ContentControl
    {
        public static readonly DependencyProperty RootsProperty =
            DependencyProperty.Register(nameof(Roots), typeof(IReadOnlyList<MuiSidebarNode>), typeof(MuiSidebar),
                new PropertyMetadata(null, (d, _) => ((MuiSidebar)d).Rebuild()));

        public static readonly DependencyProperty ToolbarEntriesProperty =
            DependencyProperty.Register(nameof(ToolbarEntries), typeof(IReadOnlyList<MuiToolbarEntry>), typeof(MuiSidebar),
                new PropertyMetadata(null, (d, e) => ((MuiSidebar)d)._toolbar.Entries = (IReadOnlyList<MuiToolbarEntry>?)e.NewValue));

        public static readonly DependencyProperty ActiveIdProperty =
            DependencyProperty.Register(nameof(ActiveId), typeof(string), typeof(MuiSidebar),
                new PropertyMetadata(null, (d, _) => ((MuiSidebar)d).Rebuild()));

        public static readonly DependencyProperty RowContextMenuProperty =
            DependencyProperty.Register(nameof(RowContextMenu), typeof(IReadOnlyList<MuiContextMenuEntry>), typeof(MuiSidebar),
                new PropertyMetadata(null));

        public IReadOnlyList<MuiSidebarNode>? Roots
        {
            get => (IReadOnlyList<MuiSidebarNode>?)GetValue(RootsProperty);
            set => SetValue(RootsProperty, value);
        }

        public IReadOnlyList<MuiToolbarEntry>? ToolbarEntries
        {
            get => (IReadOnlyList<MuiToolbarEntry>?)GetValue(ToolbarEntriesProperty);
            set => SetValue(ToolbarEntriesProperty, value);
        }

        public string? ActiveId
        {
            get => (string?)GetValue(ActiveIdProperty);
            set => SetValue(ActiveIdProperty, value);
        }

        /// <summary>Entries shown on every row's right-click context
        /// menu. Same menu shape for every node — a node-specific menu is
        /// a follow-up if a real caller ever needs one.</summary>
        public IReadOnlyList<MuiContextMenuEntry>? RowContextMenu
        {
            get => (IReadOnlyList<MuiContextMenuEntry>?)GetValue(RowContextMenuProperty);
            set => SetValue(RowContextMenuProperty, value);
        }

        public event EventHandler<string>? ItemActivated;
        public event EventHandler? ToolbarItemSelected;

        /// <summary>Fires with (nodeId, actionId) when a context-menu
        /// entry is chosen.</summary>
        public event EventHandler<(string NodeId, string ActionId)>? ContextAction;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 4 };
        private readonly MuiToolbar _toolbar = new();
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 1 };
        private readonly MuiEmptyState _empty = new() { IconName = "sidebar", Title = "No sources yet" };
        private readonly HashSet<string> _expandedIds = new();

        public MuiSidebar()
        {
            _root.Children.Add(_toolbar);
            _root.Children.Add(_rows);
            _root.Children.Add(_empty);
            Content = _root;

            _toolbar.ItemSelected += (_, _) => ToolbarItemSelected?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void Rebuild()
        {
            var roots = Roots ?? Array.Empty<MuiSidebarNode>();
            _empty.Visibility = roots.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _rows.Visibility = roots.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _rows.Children.Clear();
            foreach (var flat in MuiSidebarFlatten.Flatten(roots, _expandedIds))
            {
                var node = flat.Node;
                var row = new MuiTreeRow
                {
                    Label = node.Label,
                    IconName = node.IconName,
                    Expandable = flat.Expandable,
                    Expanded = flat.Expanded,
                    Depth = flat.Depth,
                    Count = node.Count,
                    Loading = node.Loading,
                    Active = node.Id == ActiveId,
                };
                row.Pressed += (_, _) => ItemActivated?.Invoke(this, node.Id);
                row.ExpandedChanged += (_, expanded) =>
                {
                    if (expanded) _expandedIds.Add(node.Id); else _expandedIds.Remove(node.Id);
                    Rebuild();
                };

                var menu = new MuiContextMenu { Entries = RowContextMenu };
                menu.ItemSelected += (_, actionId) =>
                {
                    menu.IsOpen = false;
                    ContextAction?.Invoke(this, (node.Id, actionId));
                };
                menu.CloseRequested += (_, _) => menu.IsOpen = false;
                row.RightTapped += (_, _) => menu.IsOpen = true;

                var cell = new Grid();
                cell.Children.Add(row);
                cell.Children.Add(menu);
                _rows.Children.Add(cell);
            }
        }
    }
}
