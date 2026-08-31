using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Disk-cached embedded-preview thumbnails, extracted by the Rust core
    /// (EXIF orientation is baked into the pixels). Two tiers (#3083):
    ///
    /// The 512px grid tier writes the CROSS-APP shared cache —
    /// `&lt;folder&gt;\.maple\thumbs\&lt;sha256_prefix16(basename)&gt;.avif`
    /// (see <see cref="ThumbCachePaths"/>) — so thumbnails travel with the
    /// photos and interchange with the Apple app, the Self Hosted
    /// API/indexer, and the web client. An existing entry is served as-is
    /// with no staleness check: originals are immutable (root CLAUDE.md
    /// principle 1 — edits go to XMP sidecars), so a thumb, once written,
    /// never needs invalidating by a source change; the same rule the API's
    /// `routes/fs-thumbs.ts` documents. When the photo folder is unwritable
    /// (read-only media, a share without write permission), the tier falls
    /// back to the machine-local cache below so thumbnails still work.
    ///
    /// The 2560px full-screen embedded-preview tier (the Preview screen's
    /// instant image, before/without a scene-linear decode) has no cross-app
    /// contract — no other client renders it — so it stays machine-local
    /// under `%LOCALAPPDATA%\Maple\local-cache`, keyed on
    /// `path|mtime|size|maxPx` so edits to the source invalidate naturally.
    /// Local entries older than 30 days are swept on construction (the same
    /// bound Apple's ThumbnailDiskCache uses), and the pre-#3083
    /// `%LOCALAPPDATA%\Maple\thumbs` directory — the private cache this
    /// class used for both tiers — is deleted once, best-effort (regenerable
    /// derived data; nothing references it any more).
    /// </summary>
    public sealed class ThumbnailService
    {
        public const int ThumbnailMaxPx = 512;
        /// <summary>Full-screen embedded-JPEG preview tier — what the Preview
        /// screen displays instantly, before/without a scene-linear decode.</summary>
        public const int PreviewMaxPx = 2560;
        private const int LocalSweepDays = 30;
        private static readonly SemaphoreSlim Gate = new(4);
        private readonly string _localCacheDir;

        public ThumbnailService()
        {
            var mapleAppData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Maple");
            _localCacheDir = Path.Combine(mapleAppData, "local-cache");
            Directory.CreateDirectory(_localCacheDir);
            var legacyDir = Path.Combine(mapleAppData, "thumbs");
            _ = Task.Run(() => CleanUpLocalCaches(legacyDir, _localCacheDir));
        }

        /// <summary>Machine-local cache path for one tier of one file —
        /// mtime/size in the key make source edits invalidate naturally
        /// (the old entry becomes an orphan for the age sweep).</summary>
        private string LocalCachePathFor(string rawPath, int maxPx, string ext)
        {
            var info = new FileInfo(rawPath);
            var key = $"{rawPath.ToLowerInvariant()}|{info.LastWriteTimeUtc.Ticks}|{info.Length}|{maxPx}";
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..32];
            return Path.Combine(_localCacheDir, $"{hash}.{ext}");
        }

        /// <summary>Returns the cached thumbnail/preview for the given file
        /// at the given size, extracting the embedded preview on first use
        /// (EXIF orientation baked in by the Rust core). Null when the
        /// source has no embedded preview or extraction fails.</summary>
        public async Task<string?> GetOrCreateAsync(
            string rawPath, CancellationToken ct, int maxPx = ThumbnailMaxPx)
        {
            return maxPx == ThumbnailMaxPx
                ? await GetOrCreateSharedThumbAsync(rawPath, ct)
                : await GetOrCreateLocalAsync(rawPath, maxPx, ct);
        }

        // --- 512px grid tier: shared `.maple/thumbs/` (#3083) ---

        private async Task<string?> GetOrCreateSharedThumbAsync(string rawPath, CancellationToken ct)
        {
            var sharedPath = ThumbCachePaths.SharedThumbPathFor(rawPath);
            if (File.Exists(sharedPath))
                return sharedPath;

            await Gate.WaitAsync(ct);
            try
            {
                if (File.Exists(sharedPath))
                    return sharedPath;
                return await Task.Run(() => RenderSharedThumb(rawPath, sharedPath), ct);
            }
            finally
            {
                Gate.Release();
            }
        }

        private string? RenderSharedThumb(string rawPath, string sharedPath)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(sharedPath)!);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Read-only folder/share — the shared cache can't live here.
                return RenderLocalFallbackThumb(rawPath);
            }

            // quality 0 = the FFI default (AVIF 55) — the exact on-share
            // write contract every other client renders at (#2690; see
            // ThumbCachePaths' header).
            var rc = RawFfi.maple_render_thumbnail_avif_to_file(
                rawPath, sharedPath, ThumbnailMaxPx, 0);
            if (rc == 0)
                return sharedPath;
            // rc 12 (tmp write) / 13 (rename) are write-side failures — the
            // folder exists but rejects our files (permissions, quota). Any
            // other rc is a decode/extract failure that a different output
            // directory can't fix.
            System.Diagnostics.Debug.WriteLine(
                $"[Thumbs] rc={rc} for {rawPath}: {RawFfi.LastError()}");
            return rc is 12 or 13 ? RenderLocalFallbackThumb(rawPath) : null;
        }

        private string? RenderLocalFallbackThumb(string rawPath)
        {
            var localPath = LocalCachePathFor(rawPath, ThumbnailMaxPx, "avif");
            if (File.Exists(localPath))
                return localPath;
            var rc = RawFfi.maple_render_thumbnail_avif_to_file(
                rawPath, localPath, ThumbnailMaxPx, 0);
            if (rc != 0)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[Thumbs] local-fallback rc={rc} for {rawPath}: {RawFfi.LastError()}");
                return null;
            }
            return localPath;
        }

        // --- 2560px embedded-preview tier: machine-local, JPEG ---

        private async Task<string?> GetOrCreateLocalAsync(string rawPath, int maxPx, CancellationToken ct)
        {
            var cachePath = LocalCachePathFor(rawPath, maxPx, "jpg");
            if (File.Exists(cachePath))
                return cachePath;

            await Gate.WaitAsync(ct);
            try
            {
                if (File.Exists(cachePath))
                    return cachePath;
                return await Task.Run(() =>
                {
                    var rc = RawFfi.maple_render_thumbnail_preview_jpeg_to_file(
                        rawPath, cachePath, (uint)maxPx, 0);
                    if (rc != 0)
                    {
                        System.Diagnostics.Debug.WriteLine(
                            $"[Thumbs] rc={rc} for {rawPath}: {RawFfi.LastError()}");
                        return null;
                    }
                    return cachePath;
                }, ct);
            }
            finally
            {
                Gate.Release();
            }
        }

        // --- Machine-local cache hygiene ---

        /// <summary>One-shot background pass on construction: delete the
        /// pre-#3083 `%LOCALAPPDATA%\Maple\thumbs` cache (nothing reads or
        /// writes it any more), and age-sweep the machine-local dir — local
        /// entries are keyed on path+mtime, so renames/moves/edits orphan
        /// them; the 30-day sweep is what keeps that bounded (#2710's
        /// machine-local half; the shared tier is cleaned synchronously by
        /// `LocalFileOperations.FinalizeRelocate`).</summary>
        private static void CleanUpLocalCaches(string legacyDir, string localCacheDir)
        {
            try
            {
                if (Directory.Exists(legacyDir))
                    Directory.Delete(legacyDir, recursive: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                DiagLog.Write($"[Thumbs] legacy cache cleanup failed: {ex.Message}");
            }

            try
            {
                var cutoff = DateTime.UtcNow.AddDays(-LocalSweepDays);
                foreach (var file in Directory.EnumerateFiles(localCacheDir))
                {
                    try
                    {
                        if (File.GetLastWriteTimeUtc(file) < cutoff)
                            File.Delete(file);
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        // A locked/vanished entry just waits for the next sweep.
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                DiagLog.Write($"[Thumbs] local cache sweep failed: {ex.Message}");
            }
        }
    }
}
