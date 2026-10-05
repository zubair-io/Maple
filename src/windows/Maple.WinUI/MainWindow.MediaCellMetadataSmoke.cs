using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private static async Task VerifyMediaCellMetadataAsync(string output, bool nativeInput)
    {
        var cell = new MuiMediaCell { Alt = "Metadata isolation photo", Filename = "Before.dng", ShowMetadata = true };
        var actions = 0;
        var ratings = 0;
        var renames = 0;
        cell.Pressed += (_, _) => actions++;
        cell.Renamed += (_, _) => renames++;
        var host = new StackPanel { Padding = new Thickness(24) };
        host.Children.Add(cell);
        var window = new Window { Title = "Maple media metadata qualification", Content = host };
        window.AppWindow.Resize(new Windows.Graphics.SizeInt32(900, 480));
        window.Activate();
        try
        {
            var deadline = Environment.TickCount64 + 5000;
            while (host.XamlRoot == null && Environment.TickCount64 < deadline) await Task.Delay(50);
            Check("metadata-window-attached", host.XamlRoot != null);
            host.UpdateLayout();
            var rating = FindDescendant<MuiRatingFlags>(cell)
                ?? throw new InvalidOperationException("Visible media rating control missing.");
            var rename = FindDescendant<MuiInlineRenameField>(cell)
                ?? throw new InvalidOperationException("Visible media rename control missing.");
            Check("metadata-controls-visible", rating.ActualWidth > 0 && rename.ActualWidth > 0);
            if (!nativeInput) return;
            host.GotFocus += (_, _) =>
            {
                var focused = FocusManager.GetFocusedElement(host.XamlRoot);
                File.AppendAllText(Path.Combine(output, "media-metadata-focus.jsonl"),
                    JsonSerializer.Serialize(new { type = focused?.GetType().FullName,
                        name = focused is FrameworkElement element ? element.Name : null }) + Environment.NewLine);
            };
            var enter = false;
            var space = false;
            rating.RatingChanged += (_, _) => ratings++;
            host.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler((_, e) =>
            {
                if (!ReferenceEquals(FocusManager.GetFocusedElement(host.XamlRoot), rating)) return;
                if (e.Key == Windows.System.VirtualKey.Enter) enter = true;
                if (e.Key == Windows.System.VirtualKey.Space) space = true;
            }), true);
            rating.Focus(FocusState.Keyboard);
            await File.WriteAllTextAsync(Path.Combine(output, "media-metadata-input.ready"),
                "Click third star; focus rating with Tab if needed; Right; Enter; Space; click filename; replace with After.dng; Enter.");
            deadline = Environment.TickCount64 + 240000;
            while ((ratings < 2 || !enter || !space || renames < 1) && Environment.TickCount64 < deadline)
                await Task.Delay(100);
            await File.WriteAllTextAsync(Path.Combine(output, "media-metadata-input.json"),
                JsonSerializer.Serialize(new { actions, ratings, renames, enter, space, cell.Rating, cell.Filename }));
            Check("metadata-native-isolation", actions == 0 && ratings == 2 && cell.Rating == 4
                && enter && space && renames == 1 && cell.Filename == "After.dng");
        }
        finally { window.Close(); }

        void Check(string name, bool passed)
        {
            File.AppendAllText(Path.Combine(output, "media-metadata.jsonl"),
                JsonSerializer.Serialize(new { name, passed, scope = nativeInput ? "native-provider-and-OS-input" : "native-provider" })
                + Environment.NewLine);
            if (!passed) throw new InvalidOperationException($"Media metadata qualification failed: {name}");
        }
    }
}
