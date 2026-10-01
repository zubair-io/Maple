using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyFilmstripMetadataAsync()
    {
        var photo = ViewModel.SelectedPhoto ?? throw new InvalidOperationException("Missing filmstrip photo");
        var oldMode = _mode;
        var rating = photo.Rating;
        try
        {
            SetMode(ShellMode.Edit);
            RebuildFilmstripRail();
            Content.UpdateLayout();
            if (Math.Abs(FilmstripRail.ActualWidth - 80) > 0.1)
                throw new InvalidOperationException("Editor filmstrip does not match the 80px reference width");
            foreach (var cell in FilmstripCells(FilmstripRail))
                if (cell.ActualWidth > 68.1 || cell.ActualHeight < 44)
                    throw new InvalidOperationException("Compact filmstrip clips a cell or shrinks its pointer target below 44px");
            SetMode(ShellMode.Preview);
            RebuildFilmstripRail();
            Content.UpdateLayout();
            var cells = FilmstripCells(FilmstripRail).ToArray();
            var images = _railBitmaps.ToArray();
            var scroll = FindDescendant<ScrollViewer>(FilmstripRail)
                ?? throw new InvalidOperationException("Missing filmstrip scroll viewer");
            var offset = scroll.VerticalOffset;
            var index = _railPhotos.IndexOf(photo);
            if (cells.Length == 0 || index < 0) throw new InvalidOperationException("Filmstrip was not realized");
            photo.Rating = rating == 4 ? 3 : 4;
            // Let queued rail invalidations run: the old implementation rebuilt
            // on the dispatcher, after the metadata property callback returned.
            await Task.Delay(100);
            Content.UpdateLayout();
            if (!cells.SequenceEqual(FilmstripCells(FilmstripRail)) || !images.SequenceEqual(_railBitmaps))
                throw new InvalidOperationException("Metadata update recreated filmstrip cells or bitmaps");
            var expected = ViewerFilmstripLogic.CullingBadgesFor(photo.Rating, photo.FlagStatus);
            if (!expected.SequenceEqual(cells[index].Badges ?? Array.Empty<string>()))
                throw new InvalidOperationException("Filmstrip rating badge did not update");
            if (Math.Abs(scroll.VerticalOffset - offset) > 0.1)
                throw new InvalidOperationException("Metadata update moved filmstrip scroll position");
        }
        finally
        {
            photo.Rating = rating;
            SetMode(oldMode);
        }
    }

    private static IEnumerable<MuiMediaCell> FilmstripCells(DependencyObject parent)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is MuiMediaCell cell) yield return cell;
            else foreach (var nested in FilmstripCells(child)) yield return nested;
        }
    }
}
