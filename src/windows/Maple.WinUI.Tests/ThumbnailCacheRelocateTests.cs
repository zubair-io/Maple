// ThumbnailCacheRelocateTests — cache invalidation on move/rename, on the
// Windows surface. Successor to the #2710 characterization test
// (ThumbnailCacheRelocateLeakTests): that test pinned down the OLD private
// cache's unbounded leak — nothing on Windows ever removed the old path's
// `%LocalAppData%\Maple\thumbs` entry — and instructed its own inversion the
// day the leak was fixed. #3083 fixed it by moving the grid tier to the
// cross-app shared cache (`<folder>\.maple\thumbs\<sha256_prefix16(basename)>.avif`,
// `ThumbCachePaths`) and wiring the old entry's reclaim into
// `LocalFileOperations.FinalizeRelocate` — the same synchronous best-effort
// delete Apple's `LocalFileOperations.invalidateDerivedCaches` performs on
// every move (see `LocalFileOperationsCacheAndIndexTests.swift`), closing
// #2710 for the shared tier. (The machine-local preview tier is bounded by
// `ThumbnailService`'s 30-day age sweep instead — not exercisable here,
// since `ThumbnailService` transitively drags WinUI types into the graph;
// see the csproj's "NOT linked" note.)
//
// Cache entries are written directly at the `ThumbCachePaths` path rather
// than through the real RAW-extracting FFI call — `ThumbnailService`
// needs `raw_ffi.dll`, which isn't available on every dev/CI machine, and
// the FFI render isn't what these tests verify anyway.

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class ThumbnailCacheRelocateTests : IDisposable
    {
        private readonly string _dir;

        public ThumbnailCacheRelocateTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-thumb-cache-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string WriteFile(string relPath, string content)
        {
            var full = Path.Combine(_dir, relPath);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        /// <summary>Simulates a photo that was already thumbnailed once:
        /// writes a stand-in entry at the exact shared-cache path the app
        /// would have used for it.</summary>
        private static string SeedThumbEntry(string photoPath)
        {
            var thumbPath = ThumbCachePaths.SharedThumbPathFor(photoPath);
            Directory.CreateDirectory(Path.GetDirectoryName(thumbPath)!);
            File.WriteAllBytes(thumbPath, new byte[] { 0x00, 0x00, 0x00, 0x1C }); // tiny AVIF-ish stand-in
            return thumbPath;
        }

        [Fact]
        public async Task Move_RemovesTheOldLocationsThumbnailCacheEntry()
        {
            var source = WriteFile("in\\IMG_1.dng", "raw bytes");
            var oldThumbPath = SeedThumbEntry(source);
            Assert.True(File.Exists(oldThumbPath), "sanity: the old cache entry was actually created before the move");

            var outDir = Path.Combine(_dir, "out");
            await LocalFileOperations.RelocateAsync(
                source, outDir, null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.False(
                File.Exists(oldThumbPath),
                "a move must reclaim the old location's shared thumbnail cache entry (#2710/#3083)");
        }

        [Fact]
        public async Task Copy_LeavesTheSourcesThumbnailCacheEntry()
        {
            // The source keeps existing after a copy — its thumb entry is
            // still live and must survive.
            var source = WriteFile("in\\IMG_2.dng", "raw bytes");
            var thumbPath = SeedThumbEntry(source);

            var outDir = Path.Combine(_dir, "out");
            await LocalFileOperations.RelocateAsync(
                source, outDir, null, RelocateMode.Copy, CollisionPolicy.Fail);

            Assert.True(File.Exists(source), "sanity: a copy leaves the source in place");
            Assert.True(
                File.Exists(thumbPath),
                "a copy must NOT touch the still-live source's thumbnail cache entry");
        }

        [Fact]
        public async Task CaseOnlyRename_RemovesTheOldCasingsThumbnailCacheEntry()
        {
            // sha256_prefix16(basename) is case-sensitive, so `IMG_3.dng` and
            // `img_3.dng` hash to different entries — the old casing's entry
            // is orphaned by the rename and must be reclaimed even though the
            // case-only-rename plan is otherwise a Finalize no-op
            // (RelocatePlan.SourceAlreadyRelocated).
            var source = WriteFile("in\\IMG_3.dng", "raw bytes");
            var oldThumbPath = SeedThumbEntry(source);
            Assert.NotEqual(
                oldThumbPath,
                ThumbCachePaths.SharedThumbPathFor(Path.Combine(Path.GetDirectoryName(source)!, "img_3.dng")));

            await LocalFileOperations.RelocateAsync(
                source, Path.GetDirectoryName(source)!, "img_3.dng", RelocateMode.Move, CollisionPolicy.Fail);

            Assert.False(
                File.Exists(oldThumbPath),
                "a case-only rename orphans the old casing's hash — its entry must be reclaimed too");
        }
    }
}
