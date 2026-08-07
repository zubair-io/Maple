// ThumbnailCacheRelocateLeakTests — #2659 verification pass: cache
// invalidation on move, on the Windows surface.
//
// `ThumbnailService.CachePathFor` (Services/ThumbnailService.cs) keys the
// on-disk thumbnail cache off `rawPath|mtime|size|maxPx`
// (`%LocalAppData%\Maple\thumbs\<hash>.jpg`; this test uses a throwaway temp
// dir standing in for that real cache dir, for isolation — the hash formula
// and leak behavior are identical either way), so a relocate DOES pick a
// fresh cache slot at the new path — the "serve a correct thumbnail at the
// new path" half of the contract holds structurally, the same way it does
// on the API and Apple surfaces (docs/caching.md: cache keys are
// path-derived).
//
// What's missing is the OTHER half. Unlike the API (`workers/cache-gc.ts`'s
// `sweepOrphanedCaches`, a background GC sweep) and Apple
// (`LocalFileOperations.invalidateDerivedCaches`, a synchronous delete of
// the old entry on every move — see
// `LocalFileOperationsCacheAndIndexTests.swift`), NOTHING on Windows ever
// removes the OLD path's cache file. `EditSessionViewModel.Rename.cs`'s
// `ApplyRenameOutcome` nulls the view-model's `ThumbnailPath`/`PreviewPath`
// and re-resolves a fresh cache entry at the NEW path — it never deletes the
// stale file left behind at the OLD path's hash. Nothing else in
// `Services/FileOperations/` touches `ThumbnailService` at all (grep finds
// no reference outside `ViewModels/EditSessionViewModel.Rename.cs`), and
// there is no Windows equivalent of `cache-gc.ts`'s sweep. So every
// rename/move of a photo that was ever thumbnailed leaves its old cache
// entry in `%LocalAppData%\Maple\thumbs\` forever — an actual unbounded
// leak, not just a bounded LRU-eviction wait.
//
// This test asserts the CORRECT behavior (the old entry is gone after a
// move) and is therefore expected to be RED against the current
// `LocalFileOperations`/`ThumbnailService` pairing — left failing loudly
// per CLAUDE.md's "expect to find bugs" directive (mirrors how
// `src/api/src/fs/relocate.parity.test.ts`'s `KNOWN_FAILURES` handles
// #2704) rather than weakened to something that would pass either way.
// Filed as #2710 (Files board) — fix is "wire an old-path cache delete (or a
// GC sweep) into the relocate/rename path," deliberately NOT attempted here
// per this ticket's instructions: this machine has no `dotnet`, so a
// production-code change to `LocalFileOperations`/`ThumbnailService` could
// only be hand-audited, never compiled or run, and CLAUDE.md flags exactly
// that risk (CS0051/CS1061/CS0246 from unverified Windows changes this
// milestone). `windows-x64` CI is the first real compiler this test — and
// any future fix — will see.

using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class ThumbnailCacheRelocateLeakTests : IDisposable
    {
        private readonly string _dir;

        public ThumbnailCacheRelocateLeakTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-thumb-cache-leak-" + Guid.NewGuid().ToString("N"));
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

        /// <summary>
        /// Reimplements `ThumbnailService.CachePathFor`
        /// (Services/ThumbnailService.cs) verbatim rather than linking that
        /// class into this test project: `ThumbnailService` itself is
        /// WinUI-free, but it transitively drags in
        /// `Native\MapleGpuLiveParams.cs` -> `Maple.WinUI.Services.DecodedImage`,
        /// which is NOT — pulling that graph in for one hash helper isn't
        /// worth the compile risk on a machine that can't build this project
        /// to check. If `ThumbnailService.CachePathFor`'s formula ever
        /// changes, this helper (and the leak this test documents) needs a
        /// matching update.
        /// </summary>
        private static string ThumbnailCachePathFor(string rawPath, string cacheDir, int maxPx = 512)
        {
            var info = new FileInfo(rawPath);
            var key = $"{rawPath.ToLowerInvariant()}|{info.LastWriteTimeUtc.Ticks}|{info.Length}|{maxPx}";
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..32];
            return Path.Combine(cacheDir, $"{hash}.jpg");
        }

        /// <summary>
        /// #2710 — a move must not leave the old path's thumbnail cache
        /// entry behind forever. Simulates a photo that was already
        /// thumbnailed once (writes directly to the cache-key path
        /// `ThumbnailCachePathFor` computes above, rather than going through
        /// the real RAW-decoding FFI call — `ThumbnailService.GetOrCreateAsync`
        /// needs `raw_ffi.dll`, which isn't available on every dev/CI
        /// machine, and isn't what this test is verifying anyway) at its OLD
        /// location, then relocates the photo and asserts the stale cache
        /// file is gone. Currently RED: nothing in the relocate/rename path
        /// ever deletes it.
        /// </summary>
        [Fact]
        public async Task Move_RemovesTheOldLocationsThumbnailCacheEntry()
        {
            var cacheDir = Path.Combine(_dir, "cache");
            Directory.CreateDirectory(cacheDir);
            var source = WriteFile("in\\IMG_1.dng", "raw bytes");
            var oldCachePath = ThumbnailCachePathFor(source, cacheDir);
            File.WriteAllBytes(oldCachePath, new byte[] { 0xFF, 0xD8, 0xFF, 0xD9 }); // tiny JPEG-ish stand-in
            Assert.True(File.Exists(oldCachePath), "sanity: the old cache entry was actually created before the move");

            var outDir = Path.Combine(_dir, "out");
            await LocalFileOperations.RelocateAsync(
                source, outDir, null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.False(
                File.Exists(oldCachePath),
                "the OLD path's thumbnail cache entry must not survive a move indefinitely — " +
                "#2710: nothing currently deletes it, so this correctly fails today");
        }
    }
}
