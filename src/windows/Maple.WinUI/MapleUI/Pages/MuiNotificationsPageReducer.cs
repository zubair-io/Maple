using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>One entry in a Notifications page demo — its own
    /// WinUI-free record (not <c>MuiNotificationEntry</c>, declared in a
    /// WinUI-dependent file) so it links into Maple.WinUI.Tests.</summary>
    public sealed record MuiMockNotification(string Id, string IconName, string Message, DateTimeOffset At, string CategoryId, bool Unread);

    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageNotifications</c>'s cross-organism wiring (#3012) — the
    /// category Chip Row filters the feed, and activating an entry both
    /// opens it and clears its unread flag (an unread count that never
    /// goes down would make the badge meaningless).</summary>
    public static class MuiNotificationsPageReducer
    {
        public static IReadOnlyList<MuiMockNotification> Filter(IReadOnlyList<MuiMockNotification> entries, string? categoryId) =>
            (categoryId is null or "all" ? entries : entries.Where(e => e.CategoryId == categoryId)).ToList();

        public static IReadOnlyList<MuiMockNotification> MarkRead(IReadOnlyList<MuiMockNotification> entries, string id) =>
            entries.Select(e => e.Id == id ? e with { Unread = false } : e).ToList();

        public static int UnreadCount(IReadOnlyList<MuiMockNotification> entries) => entries.Count(e => e.Unread);
    }
}
