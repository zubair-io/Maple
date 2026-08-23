using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Event Popover molecule (unified-component-catalog.md §3,
    /// "Event Popover" row: "Calendar event create/edit", built from
    /// Popover, Form Field, Button) — a title/time editor plus Delete/Save
    /// actions, same MuiPopover-anchoring shape as
    /// <see cref="MuiTodoPopover"/>.
    /// </summary>
    public sealed class MuiEventPopover : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiEventPopover),
                new PropertyMetadata(false, (d, e) => ((MuiEventPopover)d)._popover.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty PlacementProperty =
            DependencyProperty.Register(nameof(Placement), typeof(MuiPopoverPlacement), typeof(MuiEventPopover),
                new PropertyMetadata(MuiPopoverPlacement.Bottom, (d, e) => ((MuiEventPopover)d)._popover.Placement = (MuiPopoverPlacement)e.NewValue));

        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiEventPopover),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiEventPopover)d)._titleInput.Text = (string)e.NewValue));

        public static readonly DependencyProperty TimeLabelProperty =
            DependencyProperty.Register(nameof(TimeLabel), typeof(string), typeof(MuiEventPopover),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiEventPopover)d)._timeInput.Text = (string)e.NewValue));

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

        public string TimeLabel
        {
            get => (string)GetValue(TimeLabelProperty);
            set => SetValue(TimeLabelProperty, value);
        }

        public event EventHandler? CloseRequested;
        public event EventHandler? Saved;
        public event EventHandler? Deleted;

        private readonly MuiPopover _popover = new();
        private readonly StackPanel _panel = new() { Orientation = Orientation.Vertical, Spacing = 10, MinWidth = 240 };
        private readonly MuiInput _titleInput = new() { Placeholder = "Design review" };
        private readonly MuiFormField _titleField = new() { Label = "Title" };
        private readonly MuiInput _timeInput = new() { Placeholder = "3:00 PM" };
        private readonly MuiFormField _timeField = new() { Label = "Time" };
        private readonly StackPanel _actions = new() { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
        private readonly MuiButton _deleteButton = new() { Variant = MuiButtonVariant.Ghost, Label = "Delete" };
        private readonly MuiButton _saveButton = new() { Variant = MuiButtonVariant.Primary, Label = "Save" };

        public MuiEventPopover()
        {
            _titleField.ControlContent = _titleInput;
            _timeField.ControlContent = _timeInput;
            _actions.Children.Add(_deleteButton);
            _actions.Children.Add(_saveButton);
            _panel.Children.Add(_titleField);
            _panel.Children.Add(_timeField);
            _panel.Children.Add(_actions);
            _popover.PanelContent = _panel;
            Content = _popover;
            IsTabStop = false;

            _popover.CloseRequested += (_, _) => CloseRequested?.Invoke(this, EventArgs.Empty);
            _titleInput.Committed += (_, text) => Title = text;
            _timeInput.Committed += (_, text) => TimeLabel = text;
            _deleteButton.Click += (_, _) => Deleted?.Invoke(this, EventArgs.Empty);
            _saveButton.Click += (_, _) => Saved?.Invoke(this, EventArgs.Empty);
        }
    }
}
