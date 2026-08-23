using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Library Picker modal organism (unified-component-catalog.md
    /// §4.4, "Library Picker" row: "Remote filesystem browser", built
    /// from Tree Row, Toolbar, Empty State) — a
    /// <see cref="MuiToolbar"/> (Refresh/New Folder) above the same
    /// flattened-tree <see cref="MuiTreeRow"/> list
    /// <see cref="MuiSidebar"/>/<see cref="MuiMoveToModal"/> use, or a
    /// <see cref="MuiEmptyState"/> when the remote root is empty.
    /// </summary>
    public sealed class MuiLibraryPickerModal : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiLibraryPickerModal),
                new PropertyMetadata(false, (d, e) => ((MuiLibraryPickerModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiLibraryPickerModal),
                new PropertyMetadata(false, (d, e) => ((MuiLibraryPickerModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty RootsProperty =
            DependencyProperty.Register(nameof(Roots), typeof(IReadOnlyList<MuiSidebarNode>), typeof(MuiLibraryPickerModal),
                new PropertyMetadata(null, (d, _) => ((MuiLibraryPickerModal)d).Rebuild()));

        public static readonly DependencyProperty SelectedPathIdProperty =
            DependencyProperty.Register(nameof(SelectedPathId), typeof(string), typeof(MuiLibraryPickerModal),
                new PropertyMetadata(null, (d, _) => ((MuiLibraryPickerModal)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }

        public IReadOnlyList<MuiSidebarNode>? Roots
        {
            get => (IReadOnlyList<MuiSidebarNode>?)GetValue(RootsProperty);
            set => SetValue(RootsProperty, value);
        }

        public string? SelectedPathId { get => (string?)GetValue(SelectedPathIdProperty); set => SetValue(SelectedPathIdProperty, value); }

        public event EventHandler? Dismissed;
        public event EventHandler? RefreshRequested;
        public event EventHandler? NewFolderRequested;
        public event EventHandler<string>? PathSelected;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Sm, AriaLabel = "Library Picker" };
        private readonly MuiToolbar _toolbar = new()
        {
            Entries = new[]
            {
                MuiToolbarEntry.For(new MuiToolbarItem("refresh", "history", "Refresh")),
                MuiToolbarEntry.For(new MuiToolbarItem("new-folder", "folder", "New Folder")),
            },
        };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 1 };
        private readonly MuiEmptyState _empty = new() { IconName = "folder-open", Title = "This folder is empty" };
        private readonly MuiButton _cancel = new() { Variant = MuiButtonVariant.Ghost, Label = "Cancel" };
        private readonly MuiButton _select = new() { Variant = MuiButtonVariant.Primary, Label = "Select" };
        private readonly HashSet<string> _expandedIds = new();

        public MuiLibraryPickerModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 8 };
            body.Children.Add(_toolbar);
            body.Children.Add(_rows);
            body.Children.Add(_empty);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_cancel);
            footer.Children.Add(_select);

            _shell.Header = new MuiText { Text = "Library Picker", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _cancel.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _select.Click += (_, _) => { if (SelectedPathId is not null) PathSelected?.Invoke(this, SelectedPathId); };
            _toolbar.ItemSelected += (_, id) =>
            {
                if (id == "refresh") RefreshRequested?.Invoke(this, EventArgs.Empty);
                else if (id == "new-folder") NewFolderRequested?.Invoke(this, EventArgs.Empty);
            };

            Rebuild();
        }

        private void Rebuild()
        {
            _select.IsEnabled = !string.IsNullOrEmpty(SelectedPathId);
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
                    Active = node.Id == SelectedPathId,
                };
                row.Pressed += (_, _) => SelectedPathId = node.Id;
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
