using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Chat Message molecule (unified-component-catalog.md §3,
    /// "Chat Message" row: "One message bubble", built from Avatar, Text,
    /// Timestamp) — an avatar (omitted for <see cref="Own"/> messages),
    /// author/relative-time meta row, and the message text, right-aligned
    /// without a leading avatar for the local user's own messages, matching
    /// `mui-chat-message.component.html`.
    /// </summary>
    public sealed class MuiChatMessage : ContentControl
    {
        public static readonly DependencyProperty AuthorProperty =
            DependencyProperty.Register(nameof(Author), typeof(string), typeof(MuiChatMessage),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiChatMessage)d).Rebuild()));

        public static readonly DependencyProperty TextProperty =
            DependencyProperty.Register(nameof(Text), typeof(string), typeof(MuiChatMessage),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiChatMessage)d)._text.Text = (string)e.NewValue));

        public static readonly DependencyProperty SentAtProperty =
            DependencyProperty.Register(nameof(SentAt), typeof(DateTimeOffset), typeof(MuiChatMessage),
                new PropertyMetadata(default(DateTimeOffset), (d, e) => ((MuiChatMessage)d)._timestamp.Value = (DateTimeOffset)e.NewValue));

        public static readonly DependencyProperty OwnProperty =
            DependencyProperty.Register(nameof(Own), typeof(bool), typeof(MuiChatMessage),
                new PropertyMetadata(false, (d, _) => ((MuiChatMessage)d).Rebuild()));

        public string Author
        {
            get => (string)GetValue(AuthorProperty);
            set => SetValue(AuthorProperty, value);
        }

        public string Text
        {
            get => (string)GetValue(TextProperty);
            set => SetValue(TextProperty, value);
        }

        public DateTimeOffset SentAt
        {
            get => (DateTimeOffset)GetValue(SentAtProperty);
            set => SetValue(SentAtProperty, value);
        }

        /// <summary>Renders right-aligned, without a leading avatar, for
        /// the local user's own messages.</summary>
        public bool Own
        {
            get => (bool)GetValue(OwnProperty);
            set => SetValue(OwnProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiAvatar _avatar = new() { AvatarSize = MuiAvatarSize.Sm };
        private readonly Border _bubble = new() { CornerRadius = new CornerRadius(10), Padding = new Thickness(10, 8, 10, 8), BorderThickness = new Thickness(1) };
        private readonly StackPanel _bubbleBody = new() { Orientation = Orientation.Vertical, Spacing = 4 };
        private readonly StackPanel _meta = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
        private readonly MuiText _authorText = new() { Variant = MuiTextVariant.ChipLabel };
        private readonly MuiTimestamp _timestamp = new() { Format = MuiTimestampFormat.Relative };
        private readonly MuiText _text = new() { Variant = MuiTextVariant.Body };

        public MuiChatMessage()
        {
            _meta.Children.Add(_authorText);
            _meta.Children.Add(_timestamp);
            _bubbleBody.Children.Add(_meta);
            _bubbleBody.Children.Add(_text);
            _bubble.Child = _bubbleBody;
            _root.Children.Add(_avatar);
            _root.Children.Add(_bubble);
            Content = _root;
            IsTabStop = false;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _avatar.Name = Author;
            _avatar.Visibility = Own ? Visibility.Collapsed : Visibility.Visible;
            _authorText.Text = Author;
            _authorText.Visibility = Own ? Visibility.Collapsed : Visibility.Visible;

            _bubble.Background = Own ? R("MaplePrimaryDim") : R("MapleSurfaceAlt");
            _bubble.BorderBrush = R("MapleBorder");

            _root.HorizontalAlignment = Own ? HorizontalAlignment.Right : HorizontalAlignment.Left;
        }
    }
}
