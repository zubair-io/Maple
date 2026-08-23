// MuiNotificationsPageReducerTests — the category filter / mark-read /
// unread-count logic behind the Maple.UI Notifications page (Windows
// Pages wave, #3012). No WinUI/live Window involved.

using System;
using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiNotificationsPageReducerTests
    {
        private static MuiMockNotification[] Entries() => new[]
        {
            new MuiMockNotification("n1", "export", "Export done", DateTimeOffset.Now, "exports", true),
            new MuiMockNotification("n2", "history", "Backup done", DateTimeOffset.Now, "system", true),
            new MuiMockNotification("n3", "export", "Another export", DateTimeOffset.Now, "exports", false),
        };

        [Fact]
        public void Filter_AllCategory_ReturnsEveryEntry()
        {
            Assert.Equal(3, MuiNotificationsPageReducer.Filter(Entries(), "all").Count);
        }

        [Fact]
        public void Filter_NullCategory_ReturnsEveryEntry()
        {
            Assert.Equal(3, MuiNotificationsPageReducer.Filter(Entries(), null).Count);
        }

        [Fact]
        public void Filter_SpecificCategory_NarrowsToThatCategory()
        {
            var result = MuiNotificationsPageReducer.Filter(Entries(), "exports");
            Assert.Equal(2, result.Count);
        }

        [Fact]
        public void MarkRead_ClearsOnlyTheGivenEntrysUnreadFlag()
        {
            var result = MuiNotificationsPageReducer.MarkRead(Entries(), "n1");
            Assert.False(result.First(e => e.Id == "n1").Unread);
            Assert.True(result.First(e => e.Id == "n2").Unread);
        }

        [Fact]
        public void UnreadCount_CountsOnlyUnreadEntries()
        {
            Assert.Equal(2, MuiNotificationsPageReducer.UnreadCount(Entries()));
        }

        [Fact]
        public void UnreadCount_AfterMarkRead_Decreases()
        {
            var updated = MuiNotificationsPageReducer.MarkRead(Entries(), "n1");
            Assert.Equal(1, MuiNotificationsPageReducer.UnreadCount(updated));
        }
    }
}
