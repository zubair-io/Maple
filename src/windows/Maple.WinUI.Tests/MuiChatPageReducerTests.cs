// MuiChatPageReducerTests — the send-and-auto-reply / thread-append logic
// behind the Maple.UI Chat page (Windows Pages wave, #3012). No WinUI/
// live Window involved.

using System;
using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiChatPageReducerTests
    {
        [Fact]
        public void Send_BlankText_ReturnsMessagesUnchanged()
        {
            var messages = Array.Empty<MuiMockChatMessage>();
            var result = MuiChatPageReducer.Send(messages, "   ", DateTimeOffset.Now, "You");
            Assert.Same(messages, result);
        }

        [Fact]
        public void Send_AppendsTheUserMessageThenAnAssistantReply()
        {
            var result = MuiChatPageReducer.Send(Array.Empty<MuiMockChatMessage>(), "hello", DateTimeOffset.Now, "You");
            Assert.Equal(2, result.Count);
            Assert.True(result[0].Own);
            Assert.False(result[1].Own);
            Assert.Equal("Maple Assistant", result[1].Author);
        }

        [Fact]
        public void Send_RoutesExportKeywordToAnExportReply()
        {
            var result = MuiChatPageReducer.Send(Array.Empty<MuiMockChatMessage>(), "please export the set", DateTimeOffset.Now, "You");
            Assert.Contains("export", result[1].Text, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void Send_UnknownKeyword_UsesTheDefaultReply()
        {
            var result = MuiChatPageReducer.Send(Array.Empty<MuiMockChatMessage>(), "what's the weather", DateTimeOffset.Now, "You");
            Assert.Equal("Got it — noted on this session.", result[1].Text);
        }

        [Fact]
        public void AppendReply_BlankText_ReturnsRepliesUnchanged()
        {
            var replies = Array.Empty<MuiMockChatMessage>();
            var result = MuiChatPageReducer.AppendReply(replies, string.Empty, DateTimeOffset.Now, "You");
            Assert.Same(replies, result);
        }

        [Fact]
        public void AppendReply_DoesNotAddAnAutoReply()
        {
            var result = MuiChatPageReducer.AppendReply(Array.Empty<MuiMockChatMessage>(), "reply text", DateTimeOffset.Now, "You");
            Assert.Single(result);
        }
    }
}
