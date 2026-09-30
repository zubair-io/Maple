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
                scroll.ChangeView(null, 300, null, true);
                await Task.Delay(100);
                root.UpdateLayout();
                if (scroll.VerticalOffset <= 0)
                    throw new InvalidOperationException($"Browse did not scroll down (list={listDetail})");
                var last = ViewModel.Photos.Last();
                list.ScrollIntoView(last, ScrollIntoViewAlignment.Leading);
                await Task.Delay(100);
                root.UpdateLayout();
                if (list.ContainerFromItem(last) is not FrameworkElement container)
                    throw new InvalidOperationException("Last photo was not realized after scrolling");
                var bounds = container.TransformToVisual(list).TransformBounds(new Windows.Foundation.Rect(0, 0, container.ActualWidth, container.ActualHeight));
                if (bounds.Bottom <= 0 || bounds.Top >= list.ActualHeight)
                    throw new InvalidOperationException("Last photo remains outside the viewport");
                scroll.ChangeView(null, 0, null, true);
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
                    throw new InvalidOperationException($"Browse could not scroll back to the top (list={listDetail}, offset={scroll.VerticalOffset}, extent={scroll.ScrollableHeight})");
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
}
