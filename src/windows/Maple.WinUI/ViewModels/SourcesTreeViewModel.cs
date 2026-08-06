using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Maple.WinUI.ViewModels
{
    public enum SourceType
    {
        LocalFolder,
        ExternalDrive,
        SmbShare,
        MapleCloud
    }

    public partial class SourceNodeViewModel : ObservableObject
    {
        [ObservableProperty]
        private string _name = string.Empty;

        [ObservableProperty]
        private string _path = string.Empty;

        [ObservableProperty]
        private SourceType _type = SourceType.LocalFolder;

        public ObservableCollection<SourceNodeViewModel> Children { get; } = new();
    }

    public partial class SourcesTreeViewModel : ObservableObject
    {
        public ObservableCollection<SourceNodeViewModel> RootNodes { get; } = new();

        public SourcesTreeViewModel()
        {
            InitializeDefaultSources();
        }

        private void InitializeDefaultSources()
        {
            var localNode = new SourceNodeViewModel { Name = "Local Pictures", Path = @"C:\Users\Public\Pictures", Type = SourceType.LocalFolder };
            var externalNode = new SourceNodeViewModel { Name = "External Drives", Path = @"D:\", Type = SourceType.ExternalDrive };
            var smbNode = new SourceNodeViewModel { Name = "Network Shares (SMB)", Path = @"\\NAS\Photos", Type = SourceType.SmbShare };
            var cloudNode = new SourceNodeViewModel { Name = "Maple Cloud", Path = "cloud://self-hosted", Type = SourceType.MapleCloud };

            RootNodes.Add(localNode);
            RootNodes.Add(externalNode);
            RootNodes.Add(smbNode);
            RootNodes.Add(cloudNode);
        }
    }
}
