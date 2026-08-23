using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Todo Popover molecule (unified-component-catalog.md §3,
    /// "Todo Popover" row: "Task attribute editor", built from Popover,
    /// Form Field, Chip Row) — a task's title/priority/due-date editor,
    /// anchored the same way every Popover-composing molecule in this
    /// library is (see <see cref="MuiPopover"/>'s own doc comment on the
    /// "share a Grid cell with the trigger" convention).
    /// </summary>
    public sealed class MuiTodoPopover : ContentControl
    {
        private static readonly IReadOnlyList<MuiChip> DefaultPriorities = new[]
        {
            new MuiChip("low", "Low"),
            new MuiChip("medium", "Medium"),
            new MuiChip("high", "High"),
        };

        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiTodoPopover),
                new PropertyMetadata(false, (d, e) => ((MuiTodoPopover)d)._popover.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty PlacementProperty =
            DependencyProperty.Register(nameof(Placement), typeof(MuiPopoverPlacement), typeof(MuiTodoPopover),
                new PropertyMetadata(MuiPopoverPlacement.Bottom, (d, e) => ((MuiTodoPopover)d)._popover.Placement = (MuiPopoverPlacement)e.NewValue));

        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiTodoPopover),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiTodoPopover)d)._titleInput.Text = (string)e.NewValue));

        public static readonly DependencyProperty PrioritiesProperty =
            DependencyProperty.Register(nameof(Priorities), typeof(IReadOnlyList<MuiChip>), typeof(MuiTodoPopover),
                new PropertyMetadata(DefaultPriorities, (d, e) => ((MuiTodoPopover)d)._priorityRow.Chips = (IReadOnlyList<MuiChip>)e.NewValue));

        public static readonly DependencyProperty PriorityProperty =
            DependencyProperty.Register(nameof(Priority), typeof(string), typeof(MuiTodoPopover),
                new PropertyMetadata("medium", (d, e) => ((MuiTodoPopover)d)._priorityRow.SelectedId = (string)e.NewValue));

        public static readonly DependencyProperty DueLabelProperty =
            DependencyProperty.Register(nameof(DueLabel), typeof(string), typeof(MuiTodoPopover),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiTodoPopover)d)._dueInput.Text = (string)e.NewValue));

        public bool IsOpen
        {
            get => (bool)GetValue(IsOpenProperty);
            set => SetValue(IsOpenProperty, value);
        }

        public MuiPopoverPlacement Placement
        {
            get => (MuiPopoverPlacement)GetValue(PlacementProperty);
            set => SetValue(PlacementProperty, value);
        }

        public string Title
        {
            get => (string)GetValue(TitleProperty);
            set => SetValue(TitleProperty, value);
        }

        public IReadOnlyList<MuiChip> Priorities
        {
            get => (IReadOnlyList<MuiChip>)GetValue(PrioritiesProperty);
            set => SetValue(PrioritiesProperty, value);
        }

        public string Priority
        {
            get => (string)GetValue(PriorityProperty);
            set => SetValue(PriorityProperty, value);
        }

        public string DueLabel
        {
            get => (string)GetValue(DueLabelProperty);
            set => SetValue(DueLabelProperty, value);
        }

        public event EventHandler? CloseRequested;
        public event EventHandler? Saved;

        private readonly MuiPopover _popover = new();
        private readonly StackPanel _panel = new() { Orientation = Orientation.Vertical, Spacing = 10, MinWidth = 240 };
        private readonly MuiInput _titleInput = new() { Placeholder = "Ship feature" };
        private readonly MuiFormField _titleField = new() { Label = "Task" };
        private readonly MuiChipRow _priorityRow = new() { Mode = MuiChipRowMode.Select, Chips = DefaultPriorities, SelectedId = "medium" };
        private readonly MuiInput _dueInput = new() { Placeholder = "Fri" };
        private readonly MuiFormField _dueField = new() { Label = "Due" };

        public MuiTodoPopover()
        {
            _titleField.ControlContent = _titleInput;
            _dueField.ControlContent = _dueInput;
            _panel.Children.Add(_titleField);
            _panel.Children.Add(_priorityRow);
            _panel.Children.Add(_dueField);
            _popover.PanelContent = _panel;
            Content = _popover;
            IsTabStop = false;

            _popover.CloseRequested += (_, _) => CloseRequested?.Invoke(this, EventArgs.Empty);
            _titleInput.Committed += (_, text) => { Title = text; Save(); };
            _priorityRow.SelectionChanged += (_, id) => Priority = id;
            _dueInput.Committed += (_, text) => { DueLabel = text; Save(); };
        }

        private void Save() => Saved?.Invoke(this, EventArgs.Empty);
    }
}
