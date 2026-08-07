// SidecarStore — sidecar file IO for the Windows shell.
//
// The sidecar is the contract; the RAW is never touched (CLAUDE.md invariant
// #1). Reads are permissive (absent or unparseable file → null); writes are
// atomic (temp file in the same directory, then File.Move with overwrite) so
// a crash mid-save can never leave a truncated sidecar behind.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Maple.WinUI.Services.Xmp
{
    public static class SidecarStore
    {
        /// <summary>UTF-8 without BOM — the xpacket header carries its own U+FEFF marker.</summary>
        private static readonly Encoding Utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

        /// <summary>
        /// Video container extensions (lowercase, no dot). Mirrors the API's
        /// `VIDEO_EXTS` (`src/api/src/indexer/media-types.ts`) and Apple's
        /// `SidecarPath.videoExtensions`
        /// (`src/apple/.../MapleCore/SidecarPath.swift`) — kept as a literal
        /// list here rather than codegen'd, same rationale as the Swift
        /// mirror: small, rarely changes, not part of the color/schema
        /// single-sourcing.
        /// </summary>
        private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
        {
            "mov", "mp4", "m4v", "avi", "mkv", "webm", "mts", "m2ts", "3gp",
            "mxf", "3g2", "flv", "vob", "mpg", "wmv", "f4v",
        };

        /// <summary>True when <paramref name="path"/>'s extension names a recognised
        /// video container (case-insensitive).</summary>
        public static bool IsVideoFilename(string path) =>
            VideoExtensions.Contains(Path.GetExtension(path).TrimStart('.'));

        /// <summary>
        /// Resolve the sidecar path for a RAW/image/video file.
        ///
        /// Images use the classic same-stem convention (`photo.dng` → `photo.xmp`).
        /// Videos KEEP their extension and append `.xmp` (`clip.mov` →
        /// `clip.mov.xmp`) — the industry-standard full-name convention. This
        /// split is load-bearing for Live Photos, which store the still and
        /// the motion clip as two independent same-stem files
        /// (`IMG_1234.HEIC` + `IMG_1234.MOV`): under same-stem both would
        /// resolve to `IMG_1234.xmp` and clobber each other. Mirrors the
        /// API's `xmpSidecarPath()` (`src/api/src/fs/xmp.ts`) and Apple's
        /// `SidecarPath.sidecarURL(for:)` so the same clip edited on any
        /// surface targets the same `.xmp` file.
        /// </summary>
        public static string SidecarPathFor(string rawPath)
        {
            if (string.IsNullOrEmpty(rawPath)) throw new ArgumentException("rawPath is empty", nameof(rawPath));
            return IsVideoFilename(rawPath) ? rawPath + ".xmp" : Path.ChangeExtension(rawPath, ".xmp");
        }

        /// <summary>
        /// Load the sidecar for a RAW. Returns null when the sidecar is
        /// absent, unreadable, or not parseable as an XMP document.
        /// </summary>
        public static XmpSidecarDocument? Load(string rawPath)
        {
            var sidecarPath = SidecarPathFor(rawPath);
            string xml;
            try
            {
                if (!File.Exists(sidecarPath)) return null;
                xml = File.ReadAllText(sidecarPath, Encoding.UTF8);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return null;
            }
            return XmpParser.Parse(xml);
        }

        /// <summary>
        /// Serialize and atomically write the sidecar for a RAW. Writes to a
        /// temp file in the destination directory first, then moves over the
        /// target so readers only ever see a complete document. The RAW file
        /// itself is never opened or modified.
        /// </summary>
        public static void Save(string rawPath, XmpSidecarDocument doc)
        {
            var sidecarPath = SidecarPathFor(rawPath);
            var xml = XmpWriter.Serialize(doc);
            var tempPath = $"{sidecarPath}.{Guid.NewGuid():N}.tmp";
            try
            {
                File.WriteAllText(tempPath, xml, Utf8NoBom);
                File.Move(tempPath, sidecarPath, overwrite: true);
            }
            catch
            {
                TryDelete(tempPath);
                throw;
            }
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Best-effort cleanup — the .tmp suffix makes strays identifiable.
            }
        }
    }
}
