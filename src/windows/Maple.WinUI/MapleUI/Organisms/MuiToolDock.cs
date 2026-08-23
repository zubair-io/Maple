using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One tool in a Tool Dock group.</summary>
    public sealed record MuiToolDockItem(string Id, string IconName, string Label);

    /// <summary>One group of tools, separated from the next by a Divider.</summary>
    public sealed record MuiToolDockGroup(IReadOnlyList<MuiToolDockItem> Items);

    /// <summary>
    /// Maple.UI Tool Dock organism (unified-component-catalog.md §4.2,
    /// "Tool Dock" row: "Tool group switcher", built from Action Button,
    /// Divider, Icon) — one exclusive-select run of
    /// <see cref="MuiActionButton"/>s per group, with a
    /// <see cref="MuiDivider"/> between groups. <see cref="Orientation"/>
    /// switches both the dock's own stack direction and each button's own
    /// stacked/inline layout together, matching the desktop-sidebar vs.
    /// mobile-bottom-bar placements this dock serves.
    /// </summary>
    public sealed class MuiToolDock : ContentControl
    {
        public static readonly DependencyProperty GroupsProperty =
            DependencyProperty.Register(nameof(Groups), typeof(IReadOnlyList<MuiToolDockGroup>), typeof(MuiToolDock),
                new PropertyMetadata(null, (d, _) => ((MuiToolDock)d).Rebuild()));

        public static readonly DependencyProperty SelectedIdProperty =
            DependencyProperty.Register(nameof(SelectedId), typeof(string), typeof(MuiToolDock),
                new PropertyMetadata(null, (d, _) => ((MuiToolDock)d).RebuildSelectionVisuals()));

        public static readonly DependencyProperty OrientationProperty =
            DependencyProperty.Register(nameof(Orientation), typeof(Orientation), typeof(MuiToolDock),
                new PropertyMetadata(Orientation.Vertical, (d, _) => ((MuiToolDock)d).Rebuild()));

        public IReadOnlyList<MuiToolDockGroup>? Groups
        {
            get => (IReadOnlyList<MuiToolDockGroup>?)GetValue(GroupsProperty);
            set => SetValue(GroupsProperty, value);
        }

        public string? SelectedId
        {
            get => (string?)GetValue(SelectedIdProperty);
            set => SetValue(SelectedIdProperty, value);
        }

        public Orientation Orientation
        {
            get => (Orientation)GetValue(OrientationProperty);
            set => SetValue(OrientationProperty, value);
        }

        public event EventHandler<string>? SelectionChanged;

        private readonly StackPanel _root = new() { Spacing = 8 };
        private readonly Dictionary<string, MuiActionButton> _buttons = new();

        public MuiToolDock()
        {
            Content = _root;
            Rebuild();
        }

        private void Rebuild()
        {
            _root.Orientation = Orientation;
            _root.Children.Clear();
            _buttons.Clear();

            var groups = Groups ?? Array.Empty<MuiToolDockGroup>();
            for (var g = 0; g < groups.Count; g++)
            {
                foreach (var item in groups[g].Items)
                {
                    var button = new MuiActionButton
                    {
                        IconName = item.IconName,
                        Label = item.Label,
                        Orientation = Orientation == Orientation.Vertical
                            ? MuiActionButtonOrientation.Stacked
                            : MuiActionButtonOrientation.Horizontal,
                    };
                    button.Click += (_, _) => { SelectedId = item.Id; SelectionChanged?.Invoke(this, item.Id); };
                    _buttons[item.Id] = button;
                    _root.Children.Add(button);
                }
                if (g < groups.Count - 1)
                    _root.Children.Add(new MuiDivider
                    {
                        Orientation = Orientation == Orientation.Vertical ? MuiDividerOrientation.Horizontal : MuiDividerOrientation.Vertical,
                    });
            }
            RebuildSelectionVisuals();
        }

        private void RebuildSelectionVisuals()
        {
            foreach (var (id, button) in _buttons)
                button.Selected = id == SelectedId;
        }
    }
}
