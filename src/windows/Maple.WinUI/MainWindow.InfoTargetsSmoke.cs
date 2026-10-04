using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using System.Threading.Tasks;
using Maple.UI.Atoms;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private void VerifyInspectorActionTargets()
    {
        const double minimumTarget = 44;
        const double tolerance = .5;
        var actions = Buttons(InfoPane).Where(action => action.Visibility == Visibility.Visible).ToArray();
        var requiredNames = new[] { "Close photo info", "Clear rating", "Edit this photo’s metadata",
            "Unflagged", "Flag as pick", "Flag as reject" }
            .Concat(Enumerable.Range(1, 5).Select(rating => $"Set rating {rating}"));
        foreach (var name in requiredNames)
            if (!actions.Any(action => AutomationProperties.GetName(action) == name))
                throw new InvalidOperationException($"Inspector action is missing: {name}");
        foreach (var action in actions)
        {
            if (action.ActualWidth < minimumTarget - tolerance || action.ActualHeight < minimumTarget - tolerance)
                throw new InvalidOperationException($"Inspector target below 44 DIP: {AutomationProperties.GetName(action)} "
                    + $"{action.ActualWidth}x{action.ActualHeight}");
        }
        var clear = actions.Single(action => AutomationProperties.GetName(action) == "Clear rating");
        if (clear.Parent is not FrameworkElement parent)
            throw new InvalidOperationException("Clear rating has no realized inspector row.");
        var lastStar = _starButtons[4] ?? throw new InvalidOperationException("Fifth rating star was not built.");
        var starBounds = lastStar.TransformToVisual(parent).TransformBounds(
            new Rect(0, 0, lastStar.ActualWidth, lastStar.ActualHeight));
        var clearBounds = clear.TransformToVisual(parent).TransformBounds(
            new Rect(0, 0, clear.ActualWidth, clear.ActualHeight));
        if (starBounds.Right > clearBounds.Left + tolerance || clearBounds.Right > parent.ActualWidth + tolerance)
            throw new InvalidOperationException("Rating stars overlap Clear or exceed the inspector row.");

        static IEnumerable<FrameworkElement> Buttons(DependencyObject parent)
        {
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
            {
                var child = VisualTreeHelper.GetChild(parent, i);
                if (child is MuiButton or MuiActionButton) yield return (FrameworkElement)child;
                else foreach (var descendant in Buttons(child)) yield return descendant;
            }
        }
    }

    private async Task VerifyInspectorRetryTargetAsync()
    {
        var photo = ViewModel.SelectedPhoto ?? throw new InvalidOperationException("Retry qualification needs a local photo.");
        if (photo.IsCloud) throw new InvalidOperationException("Retry qualification requires a local sidecar.");
        var path = Services.Xmp.SidecarStore.SidecarPathFor(photo.FilePath);
        var before = Services.Xmp.SidecarStore.SnapshotHash(Services.Xmp.SidecarStore.ReadSnapshot(photo.FilePath));
        var model = ViewModel.Adjustments;
        var depth = ViewModel.UndoCount;
        // Deny the production hydration read without changing the sidecar.
        MuiButton retry;
        using (var locked = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            CancelInspectorHydration();
            HydrateInspector();
            await WaitAsync(() => ExtraInfoRows.Children.OfType<MuiButton>().Any());
            Content.UpdateLayout();
            retry = ExtraInfoRows.Children.OfType<MuiButton>().Single();
            if (AutomationProperties.GetName(retry) != "Retry photo metadata")
                throw new InvalidOperationException("Metadata read failure did not expose Retry.");
            VerifyInspectorActionTargets();
            await VerifyPanelControlReachableAsync(InfoPane, retry, "Retry photo metadata");
        }
        var invoke = FrameworkElementAutomationPeer.CreatePeerForElement(retry)?.GetPattern(PatternInterface.Invoke) as IInvokeProvider
            ?? throw new InvalidOperationException("Retry metadata has no Invoke pattern.");
        invoke.Invoke();
        await WaitAsync(() => ExtraInfoRows.Children.Count > 0 &&
            !ExtraInfoRows.Children.OfType<MuiButton>().Any() &&
            !ExtraInfoRows.Children.OfType<TextBlock>().Any(text => text.Text == "Loading metadata…"));
        if (ExtraInfoRows.Children.OfType<TextBlock>().Any(text => text.Text.Contains("unavailable") || text.Text.Contains("could not be read")))
            throw new InvalidOperationException("Metadata Retry did not recover after the read lock was released.");
        if (!ReferenceEquals(photo, ViewModel.SelectedPhoto) || !ReferenceEquals(model, ViewModel.Adjustments) ||
            depth != ViewModel.UndoCount || before != Services.Xmp.SidecarStore.SnapshotHash(Services.Xmp.SidecarStore.ReadSnapshot(photo.FilePath)))
            throw new InvalidOperationException("Metadata Retry changed the photo, history or sidecar.");

        static async Task WaitAsync(Func<bool> predicate)
        {
            var deadline = Environment.TickCount64 + 10000;
            while (!predicate())
            {
                if (Environment.TickCount64 >= deadline) throw new TimeoutException("Metadata Retry qualification did not settle.");
                await Task.Delay(25);
            }
        }
    }
}
