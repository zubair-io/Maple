// ThumbCachePaths.cs — the shared `.maple/thumbs/` cache path derivation
// (#3083), the Windows port of the cross-platform contract:
//
//     <RAW parent>/.maple/thumbs/<sha256_prefix16(basename)>.avif
//
// The hash input is the asset's filename (basename WITH extension), NOT the
// absolute path — so `.maple/` travels with the photos when the folder is
// copied to another drive or machine. All four implementations MUST agree on
// the encoding for cross-platform thumbnail reads to work:
//   - Apple:  src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/MapleThumbCacheKey.swift
//   - API:    src/api/src/fs/xmp.ts (sha256Prefix16 / resolveThumbPath)
//   - Web:    src/web/projects/maple-common/src/lib/maple-cache/sha.ts
// The agreement is pinned by the #2254 cross-platform hash vectors —
// `ThumbCachePathsTests` carries the same four filename→hex pairs as
// `xmp.test.ts`, `ThumbnailDiskCacheKeyTests.swift`, and `sha.spec.ts`.
//
// On-share WRITE contract (#2690, mirrored from MapleThumbCacheKey.swift):
// any client that writes to this path must render at exactly 512px long edge,
// AVIF quality 55 — an entry, once present, is served as-is by every other
// client with no self-healing re-render, so a wrong-parameter write
// permanently downgrades that thumb everywhere. The Windows writer satisfies
// this by calling `maple_render_thumbnail_avif_to_file` with
// `ThumbnailService.ThumbnailMaxPx` and quality 0 (= the FFI's default 55,
// the same literal `render.ts`'s THUMB_AVIF_QUALITY pins).
//
// WinUI-free by design (System + System.Security.Cryptography only): linked
// into Maple.WinUI.Tests via explicit <Compile Include>, and referenced from
// `LocalFileOperations.FinalizeRelocate`'s old-entry cleanup, which is
// likewise WinUI-free.

using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Maple.WinUI.Services
{
    public static class ThumbCachePaths
    {
        /// <summary>First 16 hex chars (8 bytes) of SHA-256 over the UTF-8
        /// text, lowercase — the exact `sha256Prefix16` every other Maple
        /// layer uses for `.maple/thumbs/` filenames.</summary>
        public static string Sha256Prefix16(string text) =>
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16]
                .ToLowerInvariant();

        /// <summary>The shared thumbnail directory for a photo folder:
        /// `&lt;folderPath&gt;\.maple\thumbs`.</summary>
        public static string SharedThumbDirFor(string folderPath) =>
            Path.Combine(folderPath, ".maple", "thumbs");

        /// <summary>The shared on-disk thumbnail path for an asset:
        /// `&lt;parent&gt;\.maple\thumbs\&lt;sha256_prefix16(basename)&gt;.avif`.
        /// Always `.avif` regardless of the source extension — every layer
        /// normalises cached thumbs to AVIF.</summary>
        public static string SharedThumbPathFor(string assetPath)
        {
            var parent = Path.GetDirectoryName(assetPath) ?? string.Empty;
            var basename = Path.GetFileName(assetPath);
            return Path.Combine(SharedThumbDirFor(parent), $"{Sha256Prefix16(basename)}.avif");
        }
    }
}
