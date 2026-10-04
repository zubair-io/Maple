using System;
using System.Collections.Generic;
using System.Linq;
using Maple.UI.Atoms;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private void VerifyInspectorActionTargets()
    {
        const double minimumTarget = 44;
        const double tolerance = .5;
        var actions = Buttons(InfoPane).ToArray();
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
        var lastStar = _starButtons[4];
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
}
