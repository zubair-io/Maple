using System;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.7 Communication gallery specimens (Chat,
    /// Notification Feed) — wave N6 second push (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsCommsSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Chat", "Chat Message list, Typing Indicator, composer, @-mention Suggestion Menu.", TemplateFrame(
                new MuiChat
                {
                    Messages = new[]
                    {
                        new MuiChatEntry("Ada", "Can we brighten the shadows?", DateTimeOffset.Now.AddMinutes(-10)),
                        new MuiChatEntry("You", "On it.", DateTimeOffset.Now.AddMinutes(-8), Own: true),
                    },
                    TypingName = "Ada",
                    Suggestions = new[] { new MuiSuggestionItem("ada", "Ada Lovelace") },
                }, 300, 320));

            AddSpecimen(panel, "Notification Feed", "Category Chip Row filters a List Row feed.", Row(
                TemplateFrame(new MuiNotificationFeed
                {
                    Categories = new[] { new MuiChip("all", "All"), new MuiChip("shares", "Shares") },
                    SelectedCategoryId = "all",
                    Entries = new[]
                    {
                        new MuiNotificationEntry("n1", "share-up-square", "Grace shared \"Wedding 2026\" with you", DateTimeOffset.Now.AddHours(-1), Unread: true),
                        new MuiNotificationEntry("n2", "check", "Export finished — 42 photos", DateTimeOffset.Now.AddHours(-5)),
                    },
                }, 260, 220),
                TemplateFrame(new MuiNotificationFeed { Entries = Array.Empty<MuiNotificationEntry>() }, 220, 220)));
        }
    }
}
