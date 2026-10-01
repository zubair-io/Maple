using System;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyBrowseScrollingAsync()
    {
        var originals = ViewModel.AllPhotos.ToArray();
        var selected = ViewModel.SelectedPhoto;
        var originalView = _browseListDetail;
        var root = (FrameworkElement)Content;
        try
        {
            SetMode(ShellMode.Browse);
            root.Width = 1024;
            root.Height = 768;
            ViewModel.AllPhotos.Clear();
            for (var i = 0; i < 120; i++)
                ViewModel.AllPhotos.Add(new PhotoItem { FilePath = $"scroll-fixture-{i:D3}.dng", FileName = $"Photo {i:D3}.dng", Format = "DNG" });
            ViewModel.ApplyFilters();
            foreach (var listDetail in new[] { false, true })
            {
                _browseListDetail = listDetail;
                UpdateBrowsePresentation();
                root.UpdateLayout();
                await Task.Delay(100);
                root.UpdateLayout();
                var list = listDetail ? (ListViewBase)BrowsePhotoList : PhotoGrid;
                var scroll = FindDescendant<ScrollViewer>(list)
                    ?? throw new InvalidOperationException("Browse has no scroll viewer");
                if (scroll.ScrollableHeight <= 0 || scroll.ScrollableWidth > 1)
                    throw new InvalidOperationException($"Browse vertical overflow missing (list={listDetail}): vertical={scroll.ScrollableHeight}, horizontal={scroll.ScrollableWidth}");
                await WaitForBrowseScrollSettledAsync(root, scroll, () => scroll.ChangeView(null, 300, null, true));
                if (scroll.VerticalOffset <= 0)
                    throw new InvalidOperationException($"Browse did not scroll down (list={listDetail})");
                var last = ViewModel.Photos.Last();
                await WaitForBrowseScrollSettledAsync(root, scroll, () => list.ScrollIntoView(last, ScrollIntoViewAlignment.Leading));
                if (list.ContainerFromItem(last) is not FrameworkElement container)
                    throw new InvalidOperationException("Last photo was not realized after scrolling");
                var bounds = container.TransformToVisual(list).TransformBounds(new Windows.Foundation.Rect(0, 0, container.ActualWidth, container.ActualHeight));
                if (bounds.Bottom <= 0 || bounds.Top >= list.ActualHeight)
                    throw new InvalidOperationException("Last photo remains outside the viewport");
                var topAccepted = scroll.ChangeView(null, 0, null, true);
                // ChangeView completion is asynchronous, even with animation disabled.
                // Wait for the actual offset instead of assuming a loaded machine
                // completes its dispatcher/layout work within one fixed 100ms delay.
                var deadline = DateTime.UtcNow.AddSeconds(5);
                do
                {
                    await Task.Delay(50);
                    root.UpdateLayout();
                } while (scroll.VerticalOffset > 1 && DateTime.UtcNow < deadline);
                if (scroll.VerticalOffset > 1)
                {
                    var firstContainer = list.ContainerFromItem(ViewModel.Photos.First()) as FrameworkElement;
                    var firstY = firstContainer?.TransformToVisual(list).TransformPoint(default).Y;
                    throw new InvalidOperationException($"Browse could not scroll back to the top (list={listDetail}, accepted={topAccepted}, offset={scroll.VerticalOffset}, extent={scroll.ScrollableHeight}, firstY={firstY}, firstHeight={firstContainer?.ActualHeight})");
                }
            }
        }
        finally
        {
            ViewModel.AllPhotos.Clear();
            foreach (var photo in originals) ViewModel.AllPhotos.Add(photo);
            ViewModel.ApplyFilters();
            _browseListDetail = originalView;
            UpdateBrowsePresentation();
            root.Width = root.Height = double.NaN;
            ViewModel.SelectedPhoto = selected;
            SetMode(ShellMode.Edit);
        }
    }

    private static async Task WaitForBrowseScrollSettledAsync(FrameworkElement root, ScrollViewer scroll, Action changeView)
    {
        // Virtualized ScrollIntoView can keep correcting its estimated extent
        // after the target container is realized. Do not race that operation
        // with the next ChangeView in the lifecycle test.
        var deadline = Environment.TickCount64 + 5000;
        var stableSince = Environment.TickCount64;
        var offset = scroll.VerticalOffset;
        var extent = scroll.ScrollableHeight;
        var finalView = false;
        void OnViewChanged(object? sender, ScrollViewerViewChangedEventArgs e)
        {
            finalView = !e.IsIntermediate;
            stableSince = Environment.TickCount64;
        }
        scroll.ViewChanged += OnViewChanged;
        try
        {
            changeView();
            while (Environment.TickCount64 < deadline)
            {
                await Task.Delay(50);
                root.UpdateLayout();
                if (Math.Abs(scroll.VerticalOffset - offset) > .1 || Math.Abs(scroll.ScrollableHeight - extent) > .1)
                {
                    stableSince = Environment.TickCount64;
                    offset = scroll.VerticalOffset;
                    extent = scroll.ScrollableHeight;
                }
                else if (finalView && Environment.TickCount64 - stableSince >= 300) return;
            }
            throw new InvalidOperationException($"Browse scrolling did not settle (finalView={finalView}, offset={scroll.VerticalOffset}, extent={scroll.ScrollableHeight})");
        }
        finally { scroll.ViewChanged -= OnViewChanged; }
    }
}
