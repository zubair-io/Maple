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
    /// (maple_render_thumbnail_preview_jpeg_to_file — EXIF orientation is baked
    /// into the pixels). Cache key includes mtime and size so edits to the
    /// source file invalidate naturally.
    /// </summary>
    public sealed class ThumbnailService
    {
        public const int ThumbnailMaxPx = 512;
        /// <summary>Full-screen embedded-JPEG preview tier — what the Preview
        /// screen displays instantly, before/without a scene-linear decode.</summary>
        public const int PreviewMaxPx = 2560;
        private static readonly SemaphoreSlim Gate = new(4);
        private readonly string _cacheDir;

        public ThumbnailService()
        {
            _cacheDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Maple", "thumbs");
            Directory.CreateDirectory(_cacheDir);
        }

        public string CachePathFor(string rawPath, int maxPx = ThumbnailMaxPx)
        {
            var info = new FileInfo(rawPath);
            var key = $"{rawPath.ToLowerInvariant()}|{info.LastWriteTimeUtc.Ticks}|{info.Length}|{maxPx}";
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..32];
            return Path.Combine(_cacheDir, $"{hash}.jpg");
        }

        /// <summary>Returns the cached embedded-preview JPEG at the given size,
        /// extracting it on first use (EXIF orientation baked in by the Rust
        /// core). Null when the source has no embedded preview or extraction
        /// fails.</summary>
        public async Task<string?> GetOrCreateAsync(
            string rawPath, CancellationToken ct, int maxPx = ThumbnailMaxPx)
        {
            var cachePath = CachePathFor(rawPath, maxPx);
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
    }
}
