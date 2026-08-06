using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Maple.WinUI.ViewModels
{
    public partial class AssetThumbnailItemViewModel : ObservableObject
    {
        [ObservableProperty]
        private string _id = string.Empty;

        [ObservableProperty]
        private string _filename = string.Empty;

        [ObservableProperty]
        private string _filePath = string.Empty;

        [ObservableProperty]
        private bool _isSelected;

        [ObservableProperty]
        private int _starRating;

        [ObservableProperty]
        private string _flagStatus = "None"; // Pick, Reject, None
    }

    public partial class LibraryGridViewModel : ObservableObject
    {
        public ObservableCollection<AssetThumbnailItemViewModel> Items { get; } = new();

        public void LoadDirectoryThumbnails(string directoryPath)
        {
            // Virtualized loading backed by raw_core.dll thumbnail loader
        }
    }
}
