using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI Chat page (unified-component-catalog.md §6 — Split
    /// Layout template hosting Chat in Center and a pinned Thread Panel
    /// in Detail). Windows Pages wave (#3012).
    ///
    /// Real wiring through <see cref="MuiChatPageReducer"/>: sending a
    /// chat message appends it AND a keyword-routed canned reply from
    /// "Maple Assistant" a beat later; the Thread Panel's own reply
    /// composer appends without an auto-reply (a thread aside is
    /// human-to-human). An @-mention picked from the suggestion menu
    /// inserts into the live draft rather than being silently dropped.
    /// </summary>
    public sealed class MuiPageChat : ContentControl
    {
        private static readonly MuiSuggestionItem[] Mentions =
        {
            new("you", "You"),
            new("assistant", "Maple Assistant"),
        };

        private readonly MuiChat _chat = new();
        private readonly MuiThreadPanel _thread = new();

        private IReadOnlyList<MuiMockChatMessage> _messages = new[]
        {
            new MuiMockChatMessage("Maple Assistant", "Welcome back — the Ridgeline Farm wedding set finished culling overnight.", DateTimeOffset.Now.AddMinutes(-30), false),
        };

        private IReadOnlyList<MuiMockChatMessage> _threadReplies = new[]
        {
            new MuiMockChatMessage("You", "Can we get the reception set exported by Friday?", DateTimeOffset.Now.AddHours(-2), true),
        };

        public MuiPageChat()
        {
            _chat.Suggestions = Mentions;
            _chat.MessageSent += (_, text) =>
            {
                _messages = MuiChatPageReducer.Send(_messages, text, DateTimeOffset.Now, "You");
                _chat.Draft = string.Empty;
                RefreshChat();
            };
            _chat.MentionSelected += (_, id) =>
            {
                var name = Mentions.First(m => m.Id == id).Label;
                _chat.Draft = $"{_chat.Draft}@{name} ";
            };

            _thread.ReplySent += (_, text) =>
            {
                _threadReplies = MuiChatPageReducer.AppendReply(_threadReplies, text, DateTimeOffset.Now, "You");
                _thread.Draft = string.Empty;
                RefreshThread();
            };

            var split = new MuiSplitLayout { Center = _chat, Detail = _thread, DetailWidth = 300 };
            Content = split;
            HorizontalContentAlignment = Microsoft.UI.Xaml.HorizontalAlignment.Stretch;
            VerticalContentAlignment = Microsoft.UI.Xaml.VerticalAlignment.Stretch;

            RefreshChat();
            RefreshThread();
        }

        private void RefreshChat() =>
            _chat.Messages = _messages.Select(m => new MuiChatEntry(m.Author, m.Text, m.SentAt, m.Own)).ToList();

        private void RefreshThread() =>
            _thread.Replies = _threadReplies.Select(m => new MuiThreadReply(m.Author, m.Text, m.SentAt, m.Own)).ToList();
    }
}
