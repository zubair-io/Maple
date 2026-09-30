using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>Versioned derivatives, shared at the 512px AVIF grid tier
    /// and machine-local at the 2560px JPEG preview tier. Cold writes develop
    /// a present XMP through the Rust recipe renderer, including its film LUT;
    /// absent sidecars use the camera preview. Current shared files are reused
    /// only while newer than the original and sidecar. Read-only libraries
    /// fall back to the local cache, keyed by both mtimes and pipeline version.
    /// Local entries older than 30 days are swept on construction.</summary>
    public sealed partial class ThumbnailService
    {
        public const int ThumbnailMaxPx = 512;
        /// <summary>Full-screen JPEG preview tier — what the Preview
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
        /// original/sidecar mtimes and pipeline version invalidate naturally
        /// (the old entry becomes an orphan for the age sweep).</summary>
        private string LocalCachePathFor(string rawPath, int maxPx, string ext)
        {
            var info = new FileInfo(rawPath);
            var sidecarAt = File.GetLastWriteTimeUtc(Xmp.SidecarStore.SidecarPathFor(rawPath)).Ticks;
            var key = $"{rawPath.ToLowerInvariant()}|{info.LastWriteTimeUtc.Ticks}|{info.Length}|{sidecarAt}|{maxPx}|v{Generated.CapabilityRegistry.PipelineOutputVersion}";
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..32];
            return Path.Combine(_localCacheDir, $"{hash}.{ext}");
        }

        /// <summary>Returns the cached thumbnail/preview for the given file
        /// at the given size, developing a sidecar or extracting the camera
        /// preview on first use. Null when the native render fails.</summary>
        public async Task<string?> GetOrCreateAsync(
            string rawPath, CancellationToken ct, int maxPx = ThumbnailMaxPx)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                if (maxPx != ThumbnailMaxPx) return await GetOrCreateLocalAsync(rawPath, maxPx, ct);
                var embedded = await GetOrCreateSharedThumbAsync(rawPath, ct);
                return embedded ?? await GetOrCreateDevelopedThumbAsync(rawPath, ct);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                ct.ThrowIfCancellationRequested();
                DiagLog.Write($"[thumb] unavailable source or cache: {error.Message}");
                return null;
            }
        }

        // --- 512px grid tier: shared `.maple/thumbs/` (#3083) ---

        private async Task<string?> GetOrCreateSharedThumbAsync(string rawPath, CancellationToken ct)
        {
            var sharedPath = ThumbCachePaths.SharedThumbPathFor(rawPath);
            if (ThumbnailRenderer.IsFresh(sharedPath, rawPath))
                return sharedPath;
            // A prior fallback render (read-only folder/share) is a cache
            // hit too. Without this check, every grid pass over a read-only
            // library would miss the fast path, queue on the gate, and
            // re-fail the shared mkdir/write on its way to the fallback —
            // the shared location is only re-attempted once the 30-day
            // sweep retires the local entry.
            var fallbackPath = LocalCachePathFor(rawPath, ThumbnailMaxPx, "avif");
            if (File.Exists(fallbackPath))
                return fallbackPath;
            var developedPath = DevelopedThumbPath(rawPath);
            if (File.Exists(developedPath)) return developedPath;

            await Gate.WaitAsync(ct);
            try
            {
                if (ThumbnailRenderer.IsFresh(sharedPath, rawPath))
                    return sharedPath;
                if (File.Exists(fallbackPath))
                    return fallbackPath;
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

            // The shared write contract is 512px long edge, AVIF quality 55.
            // A present XMP is developed before encoding; no camera fallback.
            var rc = ThumbnailRenderer.Render(rawPath, sharedPath, ThumbnailMaxPx, avif: true);
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
            var rc = ThumbnailRenderer.Render(rawPath, localPath, ThumbnailMaxPx, avif: true);
            if (rc != 0)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[Thumbs] local-fallback rc={rc} for {rawPath}: {RawFfi.LastError()}");
                return null;
            }
            return localPath;
        }

        // --- 2560px preview tier: machine-local, JPEG ---

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
                    var rc = ThumbnailRenderer.Render(rawPath, cachePath, maxPx, avif: false);
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
