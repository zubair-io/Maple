using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One message in a Chat conversation.</summary>
    public sealed record MuiChatEntry(string Author, string Text, DateTimeOffset SentAt, bool Own = false);

    /// <summary>
    /// Maple.UI Chat organism (unified-component-catalog.md §4.7, "Chat"
    /// row: "Real-time conversation", built from Chat Message, Typing
    /// Indicator, Input, Suggestion Menu) — a scrolling
    /// <see cref="MuiChatMessage"/> list, an optional
    /// <see cref="MuiTypingIndicator"/> below it, and a composer
    /// (<see cref="MuiInput"/> + Send) with an @-mention
    /// <see cref="MuiSuggestionMenu"/>.
    /// </summary>
    public sealed class MuiChat : ContentControl
    {
        public static readonly DependencyProperty MessagesProperty =
            DependencyProperty.Register(nameof(Messages), typeof(IReadOnlyList<MuiChatEntry>), typeof(MuiChat),
                new PropertyMetadata(null, (d, _) => ((MuiChat)d).Rebuild()));

        public static readonly DependencyProperty TypingNameProperty =
            DependencyProperty.Register(nameof(TypingName), typeof(string), typeof(MuiChat),
                new PropertyMetadata(null, (d, _) => ((MuiChat)d).Rebuild()));

        public static readonly DependencyProperty DraftProperty =
            DependencyProperty.Register(nameof(Draft), typeof(string), typeof(MuiChat),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiChat)d)._composer.Text = (string)e.NewValue));

        public static readonly DependencyProperty SuggestionsProperty =
            DependencyProperty.Register(nameof(Suggestions), typeof(IReadOnlyList<MuiSuggestionItem>), typeof(MuiChat),
                new PropertyMetadata(null, (d, e) => ((MuiChat)d)._suggestions.Items = (IReadOnlyList<MuiSuggestionItem>?)e.NewValue));

        public IReadOnlyList<MuiChatEntry>? Messages
        {
            get => (IReadOnlyList<MuiChatEntry>?)GetValue(MessagesProperty);
            set => SetValue(MessagesProperty, value);
        }

        public string? TypingName { get => (string?)GetValue(TypingNameProperty); set => SetValue(TypingNameProperty, value); }
        public string Draft { get => (string)GetValue(DraftProperty); set => SetValue(DraftProperty, value); }

        public IReadOnlyList<MuiSuggestionItem>? Suggestions
        {
            get => (IReadOnlyList<MuiSuggestionItem>?)GetValue(SuggestionsProperty);
            set => SetValue(SuggestionsProperty, value);
        }

        public event EventHandler<string>? MessageSent;
        public event EventHandler<string>? MentionSelected;

        private readonly Grid _root = new();
        private readonly ScrollViewer _scroll = new();
        private readonly StackPanel _messages = new() { Orientation = Orientation.Vertical, Spacing = 10 };
        private readonly MuiTypingIndicator _typing = new() { Visibility = Visibility.Collapsed };
        private readonly Grid _composerAnchor = new();
        private readonly StackPanel _composerRow = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiInput _composer = new() { Placeholder = "Message…" };
        private readonly MuiButton _mentionButton = new() { Variant = MuiButtonVariant.Ghost, Label = "@" };
        private readonly MuiButton _send = new() { Variant = MuiButtonVariant.Primary, Label = "Send" };
        private readonly MuiSuggestionMenu _suggestions = new();

        public MuiChat()
        {
            _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            _scroll.Content = _messages;
            Grid.SetRow(_scroll, 0);

            _composer.Width = double.NaN;
            _composerRow.Children.Add(_composer);
            _composerRow.Children.Add(_mentionButton);
            _composerRow.Children.Add(_send);
            _composerAnchor.Children.Add(_composerRow);
            _composerAnchor.Children.Add(_suggestions);
            Grid.SetRow(_composerAnchor, 1);

            var stack = new StackPanel { Orientation = Orientation.Vertical, Spacing = 8 };
            stack.Children.Add(_scroll);
            stack.Children.Add(_typing);
            Grid.SetRow(stack, 0);

            _root.Children.Add(stack);
            _root.Children.Add(_composerAnchor);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _composer.TextChanged += (_, text) => Draft = text;
            _composer.Committed += (_, text) => Send(text);
            _send.Click += (_, _) => Send(_composer.Text);
            _mentionButton.Click += (_, _) => _suggestions.IsOpen = true;
            _suggestions.ItemSelected += (_, id) => { _suggestions.IsOpen = false; MentionSelected?.Invoke(this, id); };
            _suggestions.CloseRequested += (_, _) => _suggestions.IsOpen = false;

            Rebuild();
        }

        private void Send(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return;
            MessageSent?.Invoke(this, text);
            Draft = string.Empty;
        }

        private void Rebuild()
        {
            _messages.Children.Clear();
            foreach (var entry in Messages ?? Array.Empty<MuiChatEntry>())
                _messages.Children.Add(new MuiChatMessage { Author = entry.Author, Text = entry.Text, SentAt = entry.SentAt, Own = entry.Own });

            _typing.Visibility = string.IsNullOrEmpty(TypingName) ? Visibility.Collapsed : Visibility.Visible;
            _typing.Name = TypingName ?? string.Empty;
        }
    }
}
