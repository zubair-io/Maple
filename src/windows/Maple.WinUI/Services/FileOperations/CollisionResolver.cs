// CollisionResolver.cs — shared "find a free destination name" algorithm for
// the relocate primitive (issue #2632). Mirrors the API's `pickFreePath`
// (`src/api/src/fs/trash.ts`) and Apple's `CollisionResolver.swift`: append
// `.N` before the extension until a free candidate is found. Bounded to the
// same 1000 attempts, and throws rather than silently handing back an
// occupied path — a caller that then wrote to it would clobber existing
// data.

using System;
using System.IO;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.FileOperations
{
    public static class CollisionResolver
    {
        /// <summary>Maximum `.N` suffixes to try before giving up — a bare
        /// limit rather than an infinite loop protects against a caller
        /// accidentally handing this a directory that already contains 1000
        /// numbered siblings.</summary>
        public const int MaxAttempts = 1000;

        /// <summary>
        /// Returns <paramref name="path"/> unchanged if it's free. Otherwise
        /// appends `.1`, `.2`, … before the extension until a free candidate
        /// is found. `exists` is async so the same algorithm can serve a
        /// synchronous local check (wrapped trivially, as
        /// <see cref="LocalFileOperations"/> does) or a real network
        /// round-trip without duplicating the suffix math.
        /// </summary>
        public static async Task<string> PickFreePathAsync(string path, Func<string, Task<bool>> exists)
        {
            if (!await exists(path).ConfigureAwait(false)) return path;

            var ext = Path.GetExtension(path); // includes the leading '.', or "" if none
            var stem = ext.Length > 0 ? path[..^ext.Length] : path;

            for (var n = 1; n <= MaxAttempts; n++)
            {
                var candidate = $"{stem}.{n}{ext}";
                if (!await exists(candidate).ConfigureAwait(false)) return candidate;
            }

            throw new FileOperationException(
                FileOperationErrorKind.Underlying,
                $"pickFreePath: exceeded {MaxAttempts} candidate paths for {path}");
        }
    }
}
