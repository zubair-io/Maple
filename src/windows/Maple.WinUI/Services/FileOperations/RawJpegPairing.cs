// RawJpegPairing.cs — which files of one listing form a RAW+JPEG stack
// (#5050, #5848). The same name rule the Self Hosted listing applies
// (`src/api/src/library/raw-jpeg-stack.ts`) and Apple's `RawJpegPairing`:
// per folder, a stem (NFC-normalised, case-folded) pairs only when it holds
// exactly one RAW and exactly one `.jpg`/`.jpeg`. Two JPEGs, two RAWs, or a
// RAW beside a HEIC stay independent. The pair shares one `<stem>.xmp`.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Maple.WinUI.Services.FileOperations
{
    public static class RawJpegPairing
    {
        // `RAW_EXTENSIONS` in src/api/src/indexer/media-types.ts;
        // RawJpegPairingTests parses that file, so a format added there fails here.
        internal static readonly IReadOnlySet<string> RawExtensions = new HashSet<string>(StringComparer.Ordinal)
        {
            "cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2", "pef", "srw",
            "x3f", "3fr", "mef", "erf", "mrw", "raw", "fff",
        };

        private static readonly IReadOnlySet<string> JpegExtensions =
            new HashSet<string>(StringComparer.Ordinal) { "jpg", "jpeg" };

        private static readonly char[] Separators = { '/', '\\' };

        public static bool IsRaw(string path) => RawExtensions.Contains(ExtensionOf(path));

        public static bool IsJpeg(string path) => JpegExtensions.Contains(ExtensionOf(path));

        public static bool IsPairCandidate(string path) => IsRaw(path) || IsJpeg(path);

        public static string Stem(string path)
        {
            var stem = SplitName(FileNameOf(path)).Stem;
            try
            {
                return stem.Normalize(NormalizationForm.FormC).ToLowerInvariant();
            }
            catch (ArgumentException)
            {
                // NTFS allows names that are not valid Unicode (a lone
                // surrogate), which cannot be normalised.
                return stem.ToLowerInvariant();
            }
        }

        public static IReadOnlyDictionary<string, string> Pairs(IEnumerable<string> paths) =>
            paths
                .GroupBy(path => (DirectoryOf(path), Stem(path)))
                .Select(group => (
                    Raws: group.Where(IsRaw).Take(2).ToList(),
                    Jpegs: group.Where(IsJpeg).Take(2).ToList()))
                .Where(members => members.Raws.Count == 1 && members.Jpegs.Count == 1)
                .ToDictionary(members => members.Raws[0], members => members.Jpegs[0], StringComparer.Ordinal);

        public static IReadOnlyDictionary<string, string> LocalPairs(IEnumerable<string> paths) =>
            Pairs(paths)
                .Where(pair => LocalFileOperations.SharesOneSidecar(pair.Key, pair.Value))
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);

        /// <summary>The JPEG's name once the RAW is named
        /// <paramref name="primaryFileName"/>: its own name while the RAW's
        /// stem is unchanged, else the RAW's new stem with the JPEG's own
        /// extension (`IMG_1.CR3` to `Trip.CR3` takes `IMG_1.JPG` to
        /// `Trip.JPG`).</summary>
        public static string CompanionFileName(
            string companionFileName, string originalPrimaryFileName, string primaryFileName)
        {
            var stem = SplitName(primaryFileName).Stem;
            return string.Equals(stem, SplitName(originalPrimaryFileName).Stem, StringComparison.Ordinal)
                ? companionFileName
                : stem + SplitName(companionFileName).Extension;
        }

        private static string ExtensionOf(string path)
        {
            var extension = SplitName(FileNameOf(path)).Extension;
            return extension.Length == 0 ? string.Empty : extension[1..].ToLowerInvariant();
        }

        // Server paths use `/` and local ones `\`; both are split here so a
        // cloud listing pairs the same on every host.
        private static string FileNameOf(string path) => path[(path.LastIndexOfAny(Separators) + 1)..];

        private static string DirectoryOf(string path)
        {
            var cut = path.LastIndexOfAny(Separators);
            return cut < 0 ? string.Empty : path[..cut];
        }

        // Node's `path.parse`: a leading dot starts a name, not an extension.
        private static (string Stem, string Extension) SplitName(string fileName)
        {
            var dot = fileName.LastIndexOf('.');
            return dot <= 0 ? (fileName, string.Empty) : (fileName[..dot], fileName[dot..]);
        }
    }
}
