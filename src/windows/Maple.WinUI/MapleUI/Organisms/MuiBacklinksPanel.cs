using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>One inbound reference to the current asset.</summary>
    public sealed record MuiBacklink(string Id, string Label, string IconName);

    /// <summary>
    /// Maple.UI Backlinks Panel organism (unified-component-catalog.md
    /// §4.3, "Backlinks Panel" row: "Inbound references", built from List
    /// Row, Empty State) — a plain list of everything that references
    /// this asset (a board card, a chat thread, a document), or an Empty
    /// State when nothing does.
    /// </summary>
    public sealed class MuiBacklinksPanel : ContentControl
    {
        public static readonly DependencyProperty BacklinksProperty =
            DependencyProperty.Register(nameof(Backlinks), typeof(IReadOnlyList<MuiBacklink>), typeof(MuiBacklinksPanel),
                new PropertyMetadata(null, (d, _) => ((MuiBacklinksPanel)d).Rebuild()));

        public IReadOnlyList<MuiBacklink>? Backlinks
        {
            get => (IReadOnlyList<MuiBacklink>?)GetValue(BacklinksProperty);
            set => SetValue(BacklinksProperty, value);
        }

        private EventHandler<string>? _backlinkActivated;
        public event EventHandler<string>? BacklinkActivated
        {
            add { _backlinkActivated += value; UpdateActions(); }
            remove { _backlinkActivated -= value; UpdateActions(); }
        }

        private void OnRowPressed(object? sender, EventArgs e)
        {
            if (sender is MuiListRow { Tag: string id }) _backlinkActivated?.Invoke(this, id);
        }

        private void UpdateActions()
        {
            foreach (var child in _rows.Children)
            {
                if (child is not MuiListRow row) continue;
                row.Pressed -= OnRowPressed;
                if (_backlinkActivated != null) row.Pressed += OnRowPressed;
            }
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly MuiEmptyState _empty = new() { IconName = "share-up-square", Title = "Nothing links here yet" };

        public MuiBacklinksPanel()
        {
            _root.Children.Add(_rows);
            _root.Children.Add(_empty);
            Content = _root;
            Rebuild();
        }

        private void Rebuild()
        {
            var backlinks = Backlinks ?? Array.Empty<MuiBacklink>();
            _empty.Visibility = backlinks.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _rows.Visibility = backlinks.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _rows.Children.Clear();
            foreach (var backlink in backlinks)
            {
                var row = new MuiListRow { Label = backlink.Label, IconName = backlink.IconName, Tag = backlink.Id };
                if (_backlinkActivated != null) row.Pressed += OnRowPressed;
                _rows.Children.Add(row);
            }
        }
    }
}
