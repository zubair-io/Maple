using System.Linq;
using Microsoft.UI.Xaml.Controls;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>Multi-selection in the library grid (#2634). PhotoGrid runs
    /// SelectionMode="Extended" (click / Ctrl+click / Shift+click / Ctrl+A,
    /// all native to GridView); this partial keeps ViewModel.SelectedPhotos in
    /// sync with the grid's own selection model and drives the Narrator-facing
    /// count text. Selection state lives on GridView.SelectedItems, which the
    /// framework tracks against the underlying data items rather than the
    /// (recycled) containers, so it survives virtualized scrolling without any
    /// extra bookkeeping here.</summary>
    public sealed partial class MainWindow
    {
        private void OnPhotoGridSelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (sender is GridView grid)
                ViewModel.SyncSelectedPhotos(grid.SelectedItems.Cast<PhotoItem>().ToList());
        }

        /// <summary>"128 photos" normally; "128 photos · 3 selected" once a
        /// multi-selection is active. The LiveSetting="Polite" on
        /// LibraryCountText (MainWindow.xaml) makes Narrator announce the
        /// change. A single selected item isn't called out here — GridView's
        /// own SelectionItem automation peer already announces that per item —
        /// so this only fires for the multi-select case this ticket adds.</summary>
        private void UpdateLibraryCountText()
        {
            var summary = ViewModel.SelectionSummary;
            var text = summary.Length > 0
                ? $"{ViewModel.Photos.Count} photos · {summary}"
                : $"{ViewModel.Photos.Count} photos";
            // Assign only on change: the TextBlock is a Polite live region,
            // and re-assigning identical text re-announces it to Narrator.
            if (LibraryCountText.Text != text)
                LibraryCountText.Text = text;
        }
    }
}
