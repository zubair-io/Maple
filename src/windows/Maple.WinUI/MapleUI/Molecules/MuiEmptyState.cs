using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Empty State molecule (unified-component-catalog.md §2.3,
    /// "Empty State" row: "Icon, title, message, optional action", built
    /// from Icon, Text, Button) — the standard "nothing here yet" filler
    /// for a grid, list, or panel with zero items.
    ///
    /// Ports `mui-empty-state.component.ts` 1:1 — icon, required title,
    /// optional message, optional action Button, centered.
    /// </summary>
    public sealed class MuiEmptyState : ContentControl
    {
        public static readonly DependencyProperty IconNameProperty =
            DependencyProperty.Register(nameof(IconName), typeof(string), typeof(MuiEmptyState),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiEmptyState)d).Rebuild()));

        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiEmptyState),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiEmptyState)d).Rebuild()));

        public static readonly DependencyProperty MessageProperty =
            DependencyProperty.Register(nameof(Message), typeof(string), typeof(MuiEmptyState),
                new PropertyMetadata(null, (d, _) => ((MuiEmptyState)d).Rebuild()));

        public static readonly DependencyProperty ActionLabelProperty =
            DependencyProperty.Register(nameof(ActionLabel), typeof(string), typeof(MuiEmptyState),
                new PropertyMetadata(null, (d, _) => ((MuiEmptyState)d).Rebuild()));

        public string IconName
        {
            get => (string)GetValue(IconNameProperty);
            set => SetValue(IconNameProperty, value);
        }

        public string Title
        {
            get => (string)GetValue(TitleProperty);
            set => SetValue(TitleProperty, value);
        }

        public string? Message
        {
            get => (string?)GetValue(MessageProperty);
            set => SetValue(MessageProperty, value);
        }

        public string? ActionLabel
        {
            get => (string?)GetValue(ActionLabelProperty);
            set => SetValue(ActionLabelProperty, value);
        }

        public event EventHandler? ActionPressed;

        private readonly StackPanel _root = new()
        {
            Orientation = Orientation.Vertical,
            Spacing = 8,
            HorizontalAlignment = HorizontalAlignment.Center,
            MaxWidth = 320,
        };
        private readonly MuiIcon _icon = new() { Size = MuiIconSize.Xl36, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly MuiText _titleText = new() { Variant = MuiTextVariant.SheetTitle, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly MuiText _messageText = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly MuiButton _actionButton = new() { Variant = MuiButtonVariant.Secondary, HorizontalAlignment = HorizontalAlignment.Center };

        public MuiEmptyState()
        {
            _root.Children.Add(_icon);
            _root.Children.Add(_titleText);
            _root.Children.Add(_messageText);
            _root.Children.Add(_actionButton);
            Content = _root;
            IsTabStop = false;

            _actionButton.Click += (_, _) => ActionPressed?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void Rebuild()
        {
            _icon.IconName = IconName;
            _titleText.Text = Title;

            _messageText.Text = Message ?? string.Empty;
            _messageText.Visibility = string.IsNullOrEmpty(Message) ? Visibility.Collapsed : Visibility.Visible;

            _actionButton.Label = ActionLabel ?? string.Empty;
            _actionButton.Visibility = string.IsNullOrEmpty(ActionLabel) ? Visibility.Collapsed : Visibility.Visible;

            if (!string.IsNullOrEmpty(Title))
                AutomationProperties.SetName(this, Title);
        }
    }
}
