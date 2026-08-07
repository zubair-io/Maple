// LocalFileOperations.Trash.cs — Delete → Trash for the local Filesystem/SMB
// source (issue #2632).
//
// Windows owns a real Recycle Bin the user already knows how to look in, so
// a delete on a local FIXED drive goes through `IRecycleBinService` — one
// shell call, recoverable from Explorer, no copy-verify-delete needed
// because the OS is the one doing the moving (mirrors macOS's
// `FileManager.trashItem` in `LocalFileOperations+Trash.swift`). Paths where
// the Recycle Bin isn't meaningfully available — network shares (SMB), and
// any path a real Recycle Bin call fails against — fall back to
// `.maple/trash/<rel>` under the library root via the SAME relocate
// primitive every other move here uses. That fallback is the documented
// story for "Recycle Bin unavailable," not a silent swallow: SMB shares
// generally have no reliable per-share recycle bin, so this module never
// even attempts one there.

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        /// <summary>Trash a single asset (primary + sidecar).</summary>
        public static async Task<RelocateOutcome> TrashAsync(
            string primaryPath, string libraryRoot, IRecycleBinService? recycleBin = null)
        {
            recycleBin ??= RecycleBinService.Instance;

            if (IsOnLocalFixedDrive(primaryPath) && recycleBin.TrySendToRecycleBin(primaryPath))
            {
                var sidecarPath = SidecarStore.SidecarPathFor(primaryPath);
                var sidecarTrashed = File.Exists(sidecarPath) && recycleBin.TrySendToRecycleBin(sidecarPath);
                // The Recycle Bin has no simple "where did it land" handle
                // the way `FileManager.trashItem`'s `resultingItemURL` does
                // — entries live under a GUID-keyed `$Recycle.Bin` folder
                // resolvable only through further shell enumeration.
                // `PrimaryPath` here means "the original path, now
                // recoverable via the OS Recycle Bin," not a literal current
                // location.
                return new RelocateOutcome(primaryPath, sidecarTrashed ? sidecarPath : null, false, sidecarTrashed);
            }

            return await TrashToMapleFolderAsync(primaryPath, libraryRoot).ConfigureAwait(false);
        }

        /// <summary>`.maple/trash/&lt;rel&gt;` fallback — SMB always; a local
        /// fixed-drive Recycle Bin call that failed also lands here. No
        /// gate on caller, so also directly testable regardless of drive
        /// type.</summary>
        internal static Task<RelocateOutcome> TrashToMapleFolderAsync(string primaryPath, string libraryRoot)
        {
            var trashDir = TrashPaths.TrashDestinationDir(primaryPath, libraryRoot);
            return RelocateAsync(primaryPath, trashDir, null, RelocateMode.Move, CollisionPolicy.AutoSuffix);
        }

        /// <summary>True when <paramref name="path"/> sits on a local FIXED
        /// drive — the only case this module attempts the real Recycle Bin.
        /// UNC network shares and any drive `DriveInfo` can't classify (or
        /// classifies as Network/Removable/etc.) fall through to the
        /// `.maple/trash/&lt;rel&gt;` path instead.</summary>
        internal static bool IsOnLocalFixedDrive(string path)
        {
            var full = Path.GetFullPath(path);
            if (full.StartsWith(@"\\", StringComparison.Ordinal)) return false; // UNC share

            var root = Path.GetPathRoot(full);
            if (string.IsNullOrEmpty(root)) return false;

            try
            {
                return new DriveInfo(root).DriveType == DriveType.Fixed;
            }
            catch (ArgumentException)
            {
                return false;
            }
        }
    }
}
