using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI Notifications page (unified-component-catalog.md §6 —
    /// App Shell template hosting a single Notification Feed). Windows
    /// Pages wave (#3012).
    ///
    /// Real wiring through <see cref="MuiNotificationsPageReducer"/>: the
    /// category Chip Row filters the visible entries; activating an
    /// entry both "opens" it (shown here as a Banner, since there's no
    /// real destination page to navigate to) and clears its unread flag
    /// — the header's unread count only ever counts what's genuinely
    /// still unread.
    /// </summary>
    public sealed class MuiPageNotifications : ContentControl
    {
        private readonly MuiNotificationFeed _feed = new();
        private readonly MuiStat _unreadStat = new() { Label = "Unread", StatSize = MuiStatSize.Sm };
        private readonly MuiBanner _banner = new() { Variant = MuiBannerVariant.Info, Dismissible = true, Visibility = Visibility.Collapsed };

        private IReadOnlyList<MuiMockNotification> _entries = new[]
        {
            new MuiMockNotification("n1", "export", "Export complete: Ceremony batch (42 photos)", DateTimeOffset.Now.AddMinutes(-12), "exports", true),
            new MuiMockNotification("n2", "history", "Backup to NAS finished — 14.2 GB synced", DateTimeOffset.Now.AddHours(-1), "system", true),
            new MuiMockNotification("n3", "share-up-square", "New comment on Iceland Roadtrip 2026", DateTimeOffset.Now.AddHours(-3), "comments", true),
            new MuiMockNotification("n4", "export", "Export complete: Studio Portraits (2 photos)", DateTimeOffset.Now.AddDays(-1), "exports", false),
            new MuiMockNotification("n5", "person-circle", "Client Brief updated for Ridgeline Farm", DateTimeOffset.Now.AddDays(-2), "comments", false),
        };
        private string _selectedCategoryId = "all";

        public MuiPageNotifications()
        {
            _feed.Categories = new[]
            {
                new MuiChip("all", "All"),
                new MuiChip("exports", "Exports"),
                new MuiChip("comments", "Comments"),
                new MuiChip("system", "System"),
            };
            _feed.SelectedCategoryId = _selectedCategoryId;
            _feed.CategorySelected += (_, categoryId) => { _selectedCategoryId = categoryId; RefreshFeed(); };
            _feed.EntryActivated += (_, id) =>
            {
                var entry = _entries.First(e => e.Id == id);
                _entries = MuiNotificationsPageReducer.MarkRead(_entries, id);
                _banner.Message = entry.Message;
                _banner.Visibility = Visibility.Visible;
                RefreshFeed();
            };

            _banner.Dismissed += (_, _) => _banner.Visibility = Visibility.Collapsed;
            _banner.ActionPressed += (_, _) => _banner.Visibility = Visibility.Collapsed;

            var header = new StackPanel { Orientation = Orientation.Horizontal, Padding = new Thickness(16, 12, 16, 0) };
            header.Children.Add(_unreadStat);

            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 4 };
            body.Children.Add(header);
            body.Children.Add(_feed);

            var shell = new MuiAppShell { MainContent = body, Overlay = _banner };
            Content = shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            RefreshFeed();
        }

        private void RefreshFeed()
        {
            _unreadStat.Value = MuiNotificationsPageReducer.UnreadCount(_entries).ToString();
            _feed.Entries = MuiNotificationsPageReducer.Filter(_entries, _selectedCategoryId)
                .Select(e => new MuiNotificationEntry(e.Id, e.IconName, e.Message, e.At, e.Unread))
                .ToList();
        }
    }
}
