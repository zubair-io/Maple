using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Move To modal organism (unified-component-catalog.md
    /// §4.4, "Move To" row: "Tree destination picker", built from Tree
    /// Row, Search Bar, Button) — a <see cref="MuiSearchBar"/> filters the
    /// same flattened-tree <see cref="MuiTreeRow"/> list
    /// <see cref="MuiSidebar"/> uses (<see cref="MuiSidebarFlatten"/>),
    /// picking one destination folder.
    /// </summary>
    public sealed class MuiMoveToModal : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiMoveToModal),
                new PropertyMetadata(false, (d, e) => ((MuiMoveToModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiMoveToModal),
                new PropertyMetadata(false, (d, e) => ((MuiMoveToModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty RootsProperty =
            DependencyProperty.Register(nameof(Roots), typeof(IReadOnlyList<MuiSidebarNode>), typeof(MuiMoveToModal),
                new PropertyMetadata(null, (d, _) => ((MuiMoveToModal)d).Rebuild()));

        public static readonly DependencyProperty SelectedDestinationIdProperty =
            DependencyProperty.Register(nameof(SelectedDestinationId), typeof(string), typeof(MuiMoveToModal),
                new PropertyMetadata(null, (d, _) => ((MuiMoveToModal)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }

        public IReadOnlyList<MuiSidebarNode>? Roots
        {
            get => (IReadOnlyList<MuiSidebarNode>?)GetValue(RootsProperty);
            set => SetValue(RootsProperty, value);
        }

        public string? SelectedDestinationId { get => (string?)GetValue(SelectedDestinationIdProperty); set => SetValue(SelectedDestinationIdProperty, value); }

        public event EventHandler? Dismissed;
        public event EventHandler<string>? MoveRequested;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Sm, AriaLabel = "Move To" };
        private readonly MuiSearchBar _search = new() { Placeholder = "Filter folders…" };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 1 };
        private readonly MuiButton _cancel = new() { Variant = MuiButtonVariant.Ghost, Label = "Cancel" };
        private readonly MuiButton _move = new() { Variant = MuiButtonVariant.Primary, Label = "Move" };
        private string _filter = string.Empty;
        private readonly HashSet<string> _expandedIds = new();

        public MuiMoveToModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 10 };
            body.Children.Add(_search);
            body.Children.Add(_rows);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_cancel);
            footer.Children.Add(_move);

            _shell.Header = new MuiText { Text = "Move To", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _cancel.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _move.Click += (_, _) => { if (SelectedDestinationId is not null) MoveRequested?.Invoke(this, SelectedDestinationId); };
            _search.Committed += (_, text) => { _filter = text; Rebuild(); };

            Rebuild();
        }

        private void Rebuild()
        {
            _move.IsEnabled = !string.IsNullOrEmpty(SelectedDestinationId);
            _rows.Children.Clear();
            var roots = Roots ?? Array.Empty<MuiSidebarNode>();
            foreach (var flat in MuiSidebarFlatten.Flatten(roots, _expandedIds))
            {
                if (!string.IsNullOrEmpty(_filter) && !flat.Node.Label.Contains(_filter, StringComparison.OrdinalIgnoreCase)) continue;

                var node = flat.Node;
                var row = new MuiTreeRow
                {
                    Label = node.Label,
                    IconName = node.IconName,
                    Expandable = flat.Expandable,
                    Expanded = flat.Expanded,
                    Depth = flat.Depth,
                    Active = node.Id == SelectedDestinationId,
                };
                row.Pressed += (_, _) => SelectedDestinationId = node.Id;
                row.ExpandedChanged += (_, expanded) =>
                {
                    if (expanded) _expandedIds.Add(node.Id); else _expandedIds.Remove(node.Id);
                    Rebuild();
                };
                _rows.Children.Add(row);
            }
        }
    }
}
