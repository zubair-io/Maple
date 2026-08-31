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
    public sealed class CloudFolderNode
    {
        public string Name { get; init; } = string.Empty;
        /// <summary>Absolute, symlink-resolved path on the server.</summary>
        public string Path { get; init; } = string.Empty;
        /// <summary>The owning library's public slug — the first half of the
        /// `slug:relPath` address the xmp/batch culling route wants.</summary>
        public string LibrarySlug { get; init; } = string.Empty;
        /// <summary>The owning library's root path, which relative addresses
        /// are computed against.</summary>
        public string LibraryPath { get; init; } = string.Empty;
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
