using System;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Foundation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyEditorPanelScrollingAsync()
    {
        var root = (FrameworkElement)Content;
        root.UpdateLayout();
        if (PanelSliders.ItemsPanelRoot?.Children.Count is not > 0)
            throw new InvalidOperationException("Light controls were not realized");
        await VerifyLastControlAsync(EditPanel,
            (FrameworkElement)PanelSliders.ItemsPanelRoot.Children[^1], "last Light row");
        await VerifyLastControlAsync(EditRail,
            (FrameworkElement)EditRailStack.Children[^1], "Crop tool");

        async Task VerifyLastControlAsync(FrameworkElement panel, FrameworkElement target, string name)
        {
            var scroll = FindDescendant<ScrollViewer>(panel)
                ?? throw new InvalidOperationException($"No scroll container for {name}");
            var offset = scroll.VerticalOffset;
            try
            {
                if (scroll.ScrollableHeight > 0)
                    await WaitForBrowseScrollSettledAsync(root, scroll,
                        () => scroll.ChangeView(null, scroll.ScrollableHeight, null, true));
                root.UpdateLayout();
                var bounds = target.TransformToVisual(scroll).TransformBounds(
                    new Rect(0, 0, target.ActualWidth, target.ActualHeight));
                if (bounds.Height <= 0 || bounds.Top < -.5 || bounds.Bottom > scroll.ViewportHeight + .5)
                    throw new InvalidOperationException($"{name} cannot be fully reached: {bounds}, " +
                        $"viewport={scroll.ViewportHeight}, offset={scroll.VerticalOffset}, extent={scroll.ScrollableHeight}");
            }
            finally
            {
                if (Math.Abs(scroll.VerticalOffset - offset) > .1)
                    await WaitForBrowseScrollSettledAsync(root, scroll,
                        () => scroll.ChangeView(null, offset, null, true));
            }
        }
    }
}
