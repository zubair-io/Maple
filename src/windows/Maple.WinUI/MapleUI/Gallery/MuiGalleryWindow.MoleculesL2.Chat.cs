using System;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Gallery
{
    /// <summary>Chat-family specimens for the Molecules L2 gallery page
    /// (wave N4, #3012) — see MuiGalleryWindow.MoleculesL2.cs for the
    /// section split rationale. ChatMessage, TypingIndicator.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildMoleculesL2ChatSpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Chat"));

            AddSpecimen(panel, "Chat Message", "One message bubble — other vs. own.", Column(
                new MuiChatMessage { Author = "Ada", Text = "Can you pull the harbor set for review?", SentAt = DateTimeOffset.Now.AddMinutes(-6) },
                new MuiChatMessage { Author = "You", Text = "On it — flagging the top twelve now.", SentAt = DateTimeOffset.Now.AddMinutes(-2), Own = true }));

            AddSpecimen(panel, "Typing Indicator", "Someone-is-typing affordance — animated dots.",
                new MuiTypingIndicator { Name = "Grace" });
        }
    }
}
