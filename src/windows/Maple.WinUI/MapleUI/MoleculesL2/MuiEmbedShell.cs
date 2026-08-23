using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Embed Shell molecule (unified-component-catalog.md §3,
    /// "Embed Shell" row: "Frame for embedded content", built from Page
    /// Header, Progress, Icon) — a <see cref="MuiPageHeader"/>, an optional
    /// leading status glyph/label row (e.g. a live-recording indicator), an
    /// indeterminate loading bar while <see cref="IsLoading"/>, and a body
    /// slot for the embedded content itself.
    /// </summary>
    public sealed class MuiEmbedShell : ContentControl
    {
        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiEmbedShell),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiEmbedShell)d)._header.Title = (string)e.NewValue));

        public static readonly DependencyProperty IsLoadingProperty =
            DependencyProperty.Register(nameof(IsLoading), typeof(bool), typeof(MuiEmbedShell),
                new PropertyMetadata(false, (d, _) => ((MuiEmbedShell)d).Rebuild()));

        public static readonly DependencyProperty StatusIconNameProperty =
            DependencyProperty.Register(nameof(StatusIconName), typeof(string), typeof(MuiEmbedShell),
                new PropertyMetadata(null, (d, _) => ((MuiEmbedShell)d).Rebuild()));

        public static readonly DependencyProperty StatusLabelProperty =
            DependencyProperty.Register(nameof(StatusLabel), typeof(string), typeof(MuiEmbedShell),
                new PropertyMetadata(null, (d, _) => ((MuiEmbedShell)d).Rebuild()));

        public static readonly DependencyProperty ShowBackProperty =
            DependencyProperty.Register(nameof(ShowBack), typeof(bool), typeof(MuiEmbedShell),
                new PropertyMetadata(true, (d, e) => ((MuiEmbedShell)d)._header.ShowBack = (bool)e.NewValue));

        public static readonly DependencyProperty BodyContentProperty =
            DependencyProperty.Register(nameof(BodyContent), typeof(object), typeof(MuiEmbedShell),
                new PropertyMetadata(null, (d, e) => ((MuiEmbedShell)d)._bodyHost.Content = e.NewValue));

        public string Title
        {
            get => (string)GetValue(TitleProperty);
            set => SetValue(TitleProperty, value);
        }

        public bool IsLoading
        {
            get => (bool)GetValue(IsLoadingProperty);
            set => SetValue(IsLoadingProperty, value);
        }

        public string? StatusIconName
        {
            get => (string?)GetValue(StatusIconNameProperty);
            set => SetValue(StatusIconNameProperty, value);
        }

        public string? StatusLabel
        {
            get => (string?)GetValue(StatusLabelProperty);
            set => SetValue(StatusLabelProperty, value);
        }

        public bool ShowBack
        {
            get => (bool)GetValue(ShowBackProperty);
            set => SetValue(ShowBackProperty, value);
        }

        public object? BodyContent
        {
            get => GetValue(BodyContentProperty);
            set => SetValue(BodyContentProperty, value);
        }

        public event EventHandler? BackRequested;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 8 };
        private readonly MuiPageHeader _header = new();
        private readonly StackPanel _statusRow = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
        private readonly MuiIcon _statusIcon = new() { Size = MuiIconSize.Sm16 };
        private readonly MuiText _statusText = new() { Variant = MuiTextVariant.ToolLabel, ColorRole = MuiTextColorRole.Muted };
        private readonly MuiProgress _progress = new() { ProgressShape = MuiProgressShape.Bar, ProgressSize = MuiProgressSize.Sm, IsIndeterminate = true };
        private readonly ContentControl _bodyHost = new() { IsTabStop = false };

        public MuiEmbedShell()
        {
            _statusRow.Children.Add(_statusIcon);
            _statusRow.Children.Add(_statusText);
            _root.Children.Add(_header);
            _root.Children.Add(_statusRow);
            _root.Children.Add(_progress);
            _root.Children.Add(_bodyHost);
            Content = _root;
            IsTabStop = false;

            _header.BackRequested += (_, _) => BackRequested?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void Rebuild()
        {
            var hasStatus = !string.IsNullOrEmpty(StatusIconName);
            _statusRow.Visibility = hasStatus ? Visibility.Visible : Visibility.Collapsed;
            _statusIcon.IconName = StatusIconName ?? string.Empty;
            _statusText.Text = StatusLabel ?? string.Empty;
            _statusText.Visibility = string.IsNullOrEmpty(StatusLabel) ? Visibility.Collapsed : Visibility.Visible;

            _progress.Visibility = IsLoading ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
