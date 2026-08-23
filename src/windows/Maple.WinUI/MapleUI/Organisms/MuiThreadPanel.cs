using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One reply message on a Thread Panel.</summary>
    public sealed record MuiThreadReply(string Author, string Text, DateTimeOffset SentAt, bool Own = false);

    /// <summary>
    /// Maple.UI Thread Panel organism (unified-component-catalog.md §4.3,
    /// "Thread Panel" row: "Reply thread", built from Chat Message,
    /// Input, Button) — a vertical stack of <see cref="MuiChatMessage"/>s
    /// (oldest first) above a composer (<see cref="MuiInput"/> + Send
    /// <see cref="MuiButton"/>) pinned to the bottom.
    /// </summary>
    public sealed class MuiThreadPanel : ContentControl
    {
        public static readonly DependencyProperty RepliesProperty =
            DependencyProperty.Register(nameof(Replies), typeof(IReadOnlyList<MuiThreadReply>), typeof(MuiThreadPanel),
                new PropertyMetadata(null, (d, _) => ((MuiThreadPanel)d).Rebuild()));

        public static readonly DependencyProperty DraftProperty =
            DependencyProperty.Register(nameof(Draft), typeof(string), typeof(MuiThreadPanel),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiThreadPanel)d)._composer.Text = (string)e.NewValue));

        public IReadOnlyList<MuiThreadReply>? Replies
        {
            get => (IReadOnlyList<MuiThreadReply>?)GetValue(RepliesProperty);
            set => SetValue(RepliesProperty, value);
        }

        public string Draft { get => (string)GetValue(DraftProperty); set => SetValue(DraftProperty, value); }

        public event EventHandler<string>? ReplySent;

        private readonly Grid _root = new();
        private readonly ScrollViewer _scroll = new();
        private readonly StackPanel _messages = new() { Orientation = Orientation.Vertical, Spacing = 10 };
        private readonly StackPanel _composerRow = new() { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Bottom };
        private readonly MuiInput _composer = new() { Placeholder = "Reply…" };
        private readonly MuiButton _send = new() { Variant = MuiButtonVariant.Primary, Label = "Send" };

        public MuiThreadPanel()
        {
            _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            _scroll.Content = _messages;
            Grid.SetRow(_scroll, 0);

            _composerRow.HorizontalAlignment = HorizontalAlignment.Stretch;
            _composer.Width = double.NaN;
            _composerRow.Children.Add(_composer);
            _composerRow.Children.Add(_send);
            Grid.SetRow(_composerRow, 1);

            _root.Children.Add(_scroll);
            _root.Children.Add(_composerRow);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _composer.TextChanged += (_, text) => Draft = text;
            _composer.Committed += (_, text) => Send(text);
            _send.Click += (_, _) => Send(_composer.Text);

            Rebuild();
        }

        private void Send(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return;
            ReplySent?.Invoke(this, text);
            Draft = string.Empty;
        }

        private void Rebuild()
        {
            _messages.Children.Clear();
            foreach (var reply in Replies ?? Array.Empty<MuiThreadReply>())
                _messages.Children.Add(new MuiChatMessage { Author = reply.Author, Text = reply.Text, SentAt = reply.SentAt, Own = reply.Own });
        }
    }
}
