using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Maple.WinUI.Generated;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        private const string WorkflowUuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

        /// <summary>A leading-dot name with no other dot (`.photo`) has no
        /// extension; <see cref="Path.GetExtension(string)"/> would call the
        /// whole name one.</summary>
        internal static (string Stem, string Extension) SplitRestoredName(string basename)
        {
            var extension = Path.GetExtension(basename);
            return extension.Length == basename.Length
                ? (basename, "")
                : (basename[..^extension.Length], extension);
        }

        internal static string[] FolderNames(string directory) =>
            Directory.Exists(directory)
                ? Directory.EnumerateFileSystemEntries(directory).Select(path => Path.GetFileName(path)).ToArray()
                : Array.Empty<string>();

        /// <summary>A restored name is taken when the file itself is, or when
        /// an edit file the restored photo would adopt is already there — its
        /// canonical or full-name `.xmp`, a `(conflict from …)` copy, or a
        /// `.v&lt;uuid&gt;.xmp` workflow copy — unless the trashed photo
        /// carries the same file under the same name with identical bytes (the
        /// edit file a same-stem sibling already restored). Foreign `.v2` and
        /// `(2)` names belong to other photos and do not count.</summary>
        internal static bool RestoreNameTaken(
            string destinationDir, IReadOnlyList<string> destinationNames, string trashPrimaryPath, string basename)
        {
            if (PathOccupied(Path.Combine(destinationDir, basename))) return true;
            var (newStem, oldStem) = (SidecarBase(basename), SidecarBase(Path.GetFileName(trashPrimaryPath)));
            var trashDir = Path.GetDirectoryName(trashPrimaryPath) ?? string.Empty;
            return PairedSidecarNames(destinationNames, basename).Any(name => !SidecarAlreadyCarried(
                Path.Combine(trashDir, oldStem + name[newStem.Length..]), Path.Combine(destinationDir, name)));
        }

        internal static IEnumerable<string> PairedSidecarNames(IEnumerable<string> names, string basename)
        {
            var stem = Regex.Escape(SidecarBase(basename));
            var canonical = new Regex("^" + stem + FilenameVocabulary.PairedSidecarSuffixPattern + "$",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            var workflow = new Regex("^(?i:" + stem + @")\.v" + WorkflowUuidPattern + @"\.xmp$",
                RegexOptions.CultureInvariant);
            return names.Where(name => canonical.IsMatch(name) || workflow.IsMatch(name));
        }

        private static string SidecarBase(string basename) =>
            SidecarStore.IsVideoFilename(basename) ? basename : SplitRestoredName(basename).Stem;
    }
}
