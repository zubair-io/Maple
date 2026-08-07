// RenameLogic.cs — pure stem/extension helpers for inline single-asset
// rename (#2639). WinUI-free by construction (plain System.IO string
// manipulation, no filesystem access) so it links into Maple.WinUI.Tests via
// this directory's existing `Services\FileOperations\*.cs` wildcard include
// (see Maple.WinUI.Tests.csproj's header comment) rather than only being
// exercisable through a live GridView. The actual relocate/validate calls
// this logic feeds live in LocalFileOperations.cs and
// Services/FilenameValidation.cs respectively — neither is pure (one touches
// the filesystem, the other crosses the FFI boundary) so neither belongs
// here.

using System;
using System.IO;

namespace Maple.WinUI.Services.FileOperations
{
    public static class RenameLogic
    {
        /// <summary>The stem (base name, no extension) of <paramref
        /// name="fileName"/> — the span an inline-rename field should
        /// pre-select so typing replaces just the base name and leaves the
        /// extension untouched by default (the design doc's "extension
        /// preserved by default").</summary>
        public static string Stem(string fileName) => Path.GetFileNameWithoutExtension(fileName);

        /// <summary>True when <paramref name="typedFileName"/>'s extension
        /// differs from <paramref name="originalFileName"/>'s — compared
        /// case-insensitively, since a bare case flip (`.CR3` → `.cr3`)
        /// isn't the "you changed the extension" case the caller warns
        /// about; it's the same NTFS case-only-rename LocalFileOperations
        /// already treats as a legitimate rename, not a format change.</summary>
        public static bool ExtensionChanged(string originalFileName, string typedFileName) =>
            !string.Equals(
                Path.GetExtension(originalFileName),
                Path.GetExtension(typedFileName),
                StringComparison.OrdinalIgnoreCase);

        /// <summary>True when <paramref name="typedFileName"/>, trimmed, is
        /// identical (ordinal) to <paramref name="originalFileName"/> — a
        /// no-op the caller should treat as "close the field, nothing to
        /// do" rather than round-tripping through the relocate primitive.
        /// NOT the same check as the case-only-rename LocalFileOperations
        /// performs: that one is a real rename (different on-disk casing);
        /// this one is "the user typed exactly what was already
        /// there".</summary>
        public static bool IsNoopRename(string originalFileName, string typedFileName) =>
            string.Equals(originalFileName, typedFileName.Trim(), StringComparison.Ordinal);
    }
}
