using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private static async Task VerifyListRowCallersAsync(string output)
    {
        var preview = new MuiPreviewList { Items = new[] { new MuiPreviewItem("rename", "Before", "After") } };
        var feed = new MuiNotificationFeed { Entries = new[]
        {
            new MuiNotificationEntry("unread", "info", "New event", DateTimeOffset.Now, true),
            new MuiNotificationEntry("read", "info", "Old event", DateTimeOffset.Now),
        } };
        var host = new StackPanel();
        host.Children.Add(preview);
        host.Children.Add(feed);
        var window = new Window { Title = "Maple list-row caller qualification", Content = host };
        window.Activate();
        try
        {
            var deadline = Environment.TickCount64 + 5000;
            while (host.XamlRoot == null && Environment.TickCount64 < deadline) await Task.Delay(50);
            Check("callers-attached", host.XamlRoot != null);
            var previewRow = (MuiListRow)((StackPanel)preview.Content).Children[0];
            var feedRows = (StackPanel)((StackPanel)feed.Content).Children[1];
            var unread = (MuiListRow)((Border)feedRows.Children[0]).Child;
            var read = (MuiListRow)((Border)feedRows.Children[1]).Child;
            Passive(previewRow, "preview-without-action");
            Passive(unread, "notification-without-action");
            var unreadPeer = FrameworkElementAutomationPeer.CreatePeerForElement(unread)!;
            var readPeer = FrameworkElementAutomationPeer.CreatePeerForElement(read)!;
            Check("unread-not-current", !unread.Active && unreadPeer.GetItemStatus() == string.Empty
                && unreadPeer.GetName() == "New event, unread" && readPeer.GetName() == "Old event");
            var actions = 0;
            EventHandler<string> previewAction = (_, id) => { if (id == "rename") actions++; };
            preview.Pressed += previewAction;
            Invoke(previewRow, "preview-with-action");
            Check("preview-real-action", actions == 1);
            preview.Pressed -= previewAction;
            Passive(previewRow, "preview-detached-action");
            EventHandler<string> notificationAction = (_, id) => { if (id == "unread") actions++; };
            feed.EntryActivated += notificationAction;
            Invoke(unread, "notification-with-action");
            Check("notification-real-action", actions == 2);
            feed.EntryActivated -= notificationAction;
            Passive(unread, "notification-detached-action");
        }
        finally { window.Close(); }

        void Passive(MuiListRow row, string name)
        {
            var peer = FrameworkElementAutomationPeer.CreatePeerForElement(row)!;
            Check(name, !row.IsTabStop && peer.GetAutomationControlType() == AutomationControlType.Group
                && peer.GetPattern(PatternInterface.Invoke) == null);
        }
        void Invoke(MuiListRow row, string name)
        {
            var peer = FrameworkElementAutomationPeer.CreatePeerForElement(row)!;
            var invoke = peer.GetPattern(PatternInterface.Invoke) as IInvokeProvider;
            Check(name, row.IsTabStop && peer.GetAutomationControlType() == AutomationControlType.Button && invoke != null);
            invoke!.Invoke();
        }
        void Check(string name, bool passed)
        {
            File.AppendAllText(Path.Combine(output, "list-row-callers.jsonl"),
                JsonSerializer.Serialize(new { name, passed, scope = "native-provider" }) + Environment.NewLine);
            if (!passed) throw new InvalidOperationException($"List-row caller regression: {name}");
        }
    }
}
