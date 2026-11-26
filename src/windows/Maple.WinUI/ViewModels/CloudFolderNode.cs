using System.Collections.ObjectModel;

namespace Maple.WinUI.ViewModels
{
    /// <summary>One row in the MAPLE CLOUD tree (#3082) — a registered server
    /// library at the top level, a server directory below it. The local
    /// FOLDERS tree's <see cref="FolderNode"/> is the same shape over the
    /// local filesystem; the two are deliberately not one type, because a
    /// cloud row also has to carry the library it belongs to (its slug, for
    /// `slug:relPath` addressing on the culling/sidecar routes) and every
    /// consumer of a FolderNode — drag-drop mounting, New Folder, Rename,
    /// Move to Trash — is a local-disk operation that has no meaning here.
    /// </summary>
    public sealed class CloudFolderNode : CommunityToolkit.Mvvm.ComponentModel.ObservableObject
    {
        private bool _isExpanded;
        private bool _isSelected;
        public bool IsExpanded { get => _isExpanded; set => SetProperty(ref _isExpanded, value); }
        public bool IsSelected { get => _isSelected; set => SetProperty(ref _isSelected, value); }
        public string Name { get; init; } = string.Empty;
        /// <summary>Absolute path on the server, in the library's registered
        /// spelling.</summary>
        public string Path { get; init; } = string.Empty;
        /// <summary>The owning library's public slug — the first half of the
        /// `slug:relPath` address the xmp/batch culling route wants.</summary>
        public string LibrarySlug { get; init; } = string.Empty;
        /// <summary>This directory's path relative to its library root, with
        /// `/` separators and no leading slash (empty at the root itself) —
        /// the second half of a `slug:relPath` address.
        ///
        /// Accumulated down the tree from directory names, the way the server
        /// composes the same address. It is what the listing is requested by:
        /// the absolute path is not subtracted instead, because /api/folders
        /// reports the root as it was registered.</summary>
        public string RelativePath { get; init; } = string.Empty;
        public ObservableCollection<CloudFolderNode> Children { get; } = new();
        /// <summary>True once the real children replaced the expander stub.</summary>
        public bool ChildrenLoaded { get; set; }
        /// <summary>Marker child that shows the expander chevron before the
        /// real children have been listed. Unlike the local tree — which can
        /// cheaply stat for subdirectories while building a node — a server
        /// listing costs a round-trip, so every cloud node gets a stub and
        /// resolves to a leaf on first expand.</summary>
        public bool IsPlaceholder { get; init; }
        public string ToolTipText => Path;
    }
}
