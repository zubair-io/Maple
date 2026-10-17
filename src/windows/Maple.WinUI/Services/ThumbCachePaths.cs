// ThumbCachePaths.cs — the shared `.maple/thumbs/` cache path derivation,
// the Windows port of the cross-platform contract (#4793):
//
//     <RAW parent>/.maple/thumbs/<filename.ext>.avif
//
// Named by the asset's filename (basename WITH extension), NOT the absolute
// path — so `.maple/` travels with the photos when the folder is copied to
// another drive or machine. Unversioned: a pipeline bump never invalidates a
// shared thumbnail.
//
// Folders written before #4793 hold `<sha256_prefix16(basename)>.v25.avif`.
// A read miss renames that one frozen legacy name into place
// (AdoptLegacySharedThumb), never re-renders. Sha256Prefix16 exists only for
// that lookup; its #2254 cross-platform vectors stay pinned in
// `ThumbCachePathsTests` because the API sweep and the Apple/Web readers
// must still agree on which legacy file belongs to which photo.
//
// On-share WRITE contract (#2690, mirrored from MapleThumbCacheKey.swift):
// any client that writes to this path must render at exactly 512px long edge,
// AVIF quality 55 — an entry, once present, is served as-is by every other
// client with no self-healing re-render, so a wrong-parameter write
// permanently downgrades that thumb everywhere. The Windows writer satisfies
// this through ThumbnailRenderer at ThumbnailService.ThumbnailMaxPx and
// AVIF quality 55, with edits and film restored from the sidecar snapshot.
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
        /// text, lowercase — the pre-#4793 `.maple/thumbs/` name stem, kept
        /// only to find legacy entries.</summary>
        public static string Sha256Prefix16(string text) =>
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16]
                .ToLowerInvariant();

        /// <summary>The shared thumbnail directory for a photo folder:
        /// `&lt;folderPath&gt;\.maple\thumbs`.</summary>
        public static string SharedThumbDirFor(string folderPath) =>
            Path.Combine(folderPath, ".maple", "thumbs");

        /// <summary>The shared on-disk thumbnail path for an asset:
        /// `&lt;parent&gt;\.maple\thumbs\&lt;filename.ext&gt;.avif`. Always
        /// `.avif` appended to the full filename — every layer normalises
        /// cached thumbs to AVIF.</summary>
        public static string SharedThumbPathFor(string assetPath)
        {
            var parent = Path.GetDirectoryName(assetPath) ?? string.Empty;
            return Path.Combine(SharedThumbDirFor(parent), $"{Path.GetFileName(assetPath)}.avif");
        }

        /// <summary>The frozen pre-#4793 name,
        /// `&lt;sha256_prefix16(basename)&gt;.v25.avif`.</summary>
        public static string LegacySharedThumbPathFor(string assetPath)
        {
            var parent = Path.GetDirectoryName(assetPath) ?? string.Empty;
            var basename = Path.GetFileName(assetPath);
            return Path.Combine(SharedThumbDirFor(parent), $"{Sha256Prefix16(basename)}.v25.avif");
        }

        /// <summary>Call on a miss for the current name: renames a legacy
        /// `.v25` entry into place (one extra lookup). Returns the current
        /// path once adopted, the legacy path itself when the folder refuses
        /// the rename (read-only share), and null when no legacy entry
        /// exists.</summary>
        public static string? AdoptLegacySharedThumb(string assetPath)
        {
            var legacyPath = LegacySharedThumbPathFor(assetPath);
            if (!File.Exists(legacyPath)) return null;
            var sharedPath = SharedThumbPathFor(assetPath);
            try
            {
                File.Move(legacyPath, sharedPath, overwrite: false);
                return sharedPath;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // A concurrent reader may have won the rename; otherwise the
                // folder is read-only and the legacy bytes serve in place.
                return File.Exists(sharedPath) ? sharedPath
                    : File.Exists(legacyPath) ? legacyPath
                    : null;
            }
        }
    }
}
