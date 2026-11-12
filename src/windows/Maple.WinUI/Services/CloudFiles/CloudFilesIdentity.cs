// The FileIdentity blob a Maple Cloud placeholder carries (#5852): the
// entry's `slug:relPath` address, behind a prefix no absolute path can
// start with. Builds before #5852 stamped the absolute server path the
// /api/fs/dir listing named the entry by; those placeholders persist in the
// registered sync root across upgrades, so a legacy identity is resolved to
// an address against the registered library roots instead.

using System;
using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.Services.CloudFiles
{
    internal static class CloudFilesIdentity
    {
        private const string AddressPrefix = "address:";

        internal static string FromAddress(string address) => AddressPrefix + address;

        internal static string ForLibrary(CloudFolder library) => FromAddress(library.Slug + ":");

        internal static bool IsAddress(string identity) =>
            identity.StartsWith(AddressPrefix, StringComparison.Ordinal);

        /// <summary>The address an identity names, or null when it names
        /// nothing addressable. <paramref name="libraries"/> is consulted
        /// only for a legacy absolute-path identity.</summary>
        internal static string? ToAddress(string identity, IReadOnlyCollection<CloudFolder>? libraries)
        {
            if (IsAddress(identity))
                return identity[AddressPrefix.Length..];
            return libraries == null ? null : LegacyPathToAddress(identity, libraries);
        }

        /// <summary>The longest library root the path sits under, matched at a
        /// separator boundary so `/srv/lib` never claims `/srv/library`.
        /// Ordinal: the identity is the server's own spelling. A path under a
        /// symlinked root was stamped symlink-resolved and matches nothing —
        /// that placeholder reports failure rather than guessing.</summary>
        private static string? LegacyPathToAddress(string path, IEnumerable<CloudFolder> libraries)
        {
            foreach (var library in libraries.OrderByDescending(library => library.Path.Length))
            {
                var root = library.Path.TrimEnd('/', '\\');
                if (path.Length > 0 && path.TrimEnd('/', '\\') == root)
                    return library.Slug + ":";
                if (path.Length > root.Length
                    && path.StartsWith(root, StringComparison.Ordinal)
                    && path[root.Length] is '/' or '\\')
                    return library.Slug + ":" + path[(root.Length + 1)..].Replace('\\', '/');
            }
            return null;
        }
    }
}
