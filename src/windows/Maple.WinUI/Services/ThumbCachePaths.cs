// ThumbCachePaths.cs — the shared `.maple/thumbs/` cache path derivation
// (#3083), the Windows port of the cross-platform contract:
//
//     <RAW parent>/.maple/thumbs/<sha256_prefix16(basename)>.avif
//
// Unversioned by contract (#4793): a pipeline bump never invalidates a
// shared thumbnail. Folders written while the name carried `.v25` migrate by
// rename on a read miss (AdoptLegacySharedThumb), never by re-render.
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

        /// <summary>The frozen pre-#4793 name, `&lt;sha16&gt;.v25.avif` — the
        /// only versioned spelling any shipped Windows build wrote.</summary>
        public static string LegacySharedThumbPathFor(string assetPath)
        {
            var parent = Path.GetDirectoryName(assetPath) ?? string.Empty;
            var basename = Path.GetFileName(assetPath);
            return Path.Combine(SharedThumbDirFor(parent), $"{Sha256Prefix16(basename)}.v25.avif");
        }

        /// <summary>Call on a miss for the unversioned name: renames a
        /// legacy `.v25` entry into place (one extra lookup). Returns the
        /// unversioned path once adopted, the legacy path itself when the
        /// folder refuses the rename (read-only share), and null when no
        /// legacy entry exists.</summary>
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
