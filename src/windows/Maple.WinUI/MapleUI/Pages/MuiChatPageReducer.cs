using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>One line in a Chat or Thread Panel demo — its own
    /// WinUI-free record (not <c>MuiChatEntry</c>/<c>MuiThreadReply</c>,
    /// each declared in a WinUI-dependent file) so it links into
    /// Maple.WinUI.Tests.</summary>
    public sealed record MuiMockChatMessage(string Author, string Text, DateTimeOffset SentAt, bool Own);

    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageChat</c>'s cross-organism wiring (#3012) — sending a
    /// message appends it, then a keyword-routed canned reply from "Maple
    /// Assistant" a beat later (so the Chat organism has something to
    /// show beyond an empty echo chamber); the Thread Panel's own reply
    /// composer reuses the same append rule without the auto-reply, since
    /// a thread reply is a human-to-human aside, not a chat with the
    /// assistant.</summary>
    public static class MuiChatPageReducer
    {
        public static IReadOnlyList<MuiMockChatMessage> Send(
            IReadOnlyList<MuiMockChatMessage> messages, string text, DateTimeOffset now, string senderName)
        {
            if (string.IsNullOrWhiteSpace(text)) return messages;

            var next = messages.ToList();
            next.Add(new MuiMockChatMessage(senderName, text.Trim(), now, true));
            next.Add(new MuiMockChatMessage("Maple Assistant", ReplyFor(text), now.AddSeconds(1), false));
            return next;
        }

        public static IReadOnlyList<MuiMockChatMessage> AppendReply(
            IReadOnlyList<MuiMockChatMessage> replies, string text, DateTimeOffset now, string senderName)
        {
            if (string.IsNullOrWhiteSpace(text)) return replies;

            var next = replies.ToList();
            next.Add(new MuiMockChatMessage(senderName, text.Trim(), now, true));
            return next;
        }

        private static string ReplyFor(string text)
        {
            var lower = text.ToLowerInvariant();
            if (lower.Contains("export")) return "I'll queue that export once you confirm the destination folder.";
            if (lower.Contains("cull") || lower.Contains("select")) return "Selecting the top-rated frames from Ceremony now.";
            if (lower.Contains("iceland")) return "The Iceland roadtrip set is fully culled — 4 keepers flagged.";
            return "Got it — noted on this session.";
        }
    }
}
