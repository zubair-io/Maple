// RenameIndexStore.cs — persisted per-folder fingerprint snapshot backing
// the closed-app rename-reconciliation fallback (#2657,
// RenameReconciliationLogic.cs). A rename that happens while Maple is
// closed leaves no live FileSystemWatcher event to follow, so the ONLY way
// to recognize it on the next scan is to remember what the folder looked
// like the last time Maple scanned it and diff against that. This is that
// memory: one small JSON snapshot per folder, keyed by a hash of the
// folder's path (mirrors ThumbnailService.CachePathFor's
// LocalApplicationData + SHA256-prefix scheme), holding just the cheap
// fingerprint fields (size, EXIF capture time, camera serial) — never
// pixels, never the sidecar contents.
//
// WinUI-free (System.IO/Text.Json only) so it links into
// Maple.WinUI.Tests via the `Services\FileOperations\*.cs` wildcard
// include and is exercisable with real temp directories, same as
// SidecarStore's atomic-write contract that this mirrors (temp file in the
// same directory, then File.Move with overwrite).
//
// The cache root is a caller-supplied directory rather than something this
// class resolves itself via Environment.SpecialFolder — production passes
// `%LocalAppData%\Maple\rename-index`, tests pass a temp directory, and
// this class never has to know the difference.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Maple.WinUI.Services.FileOperations
{
    public static class RenameIndexStore
    {
        private const int CurrentVersion = 1;

        /// <summary>The on-disk snapshot path for <paramref name="folderPath"/>
        /// under <paramref name="cacheRootDir"/> — a case-insensitive hash of
        /// the normalized folder path, so `C:\Photos` and `c:\photos\` share
        /// one entry.</summary>
        public static string IndexPathFor(string cacheRootDir, string folderPath)
        {
            var normalized = folderPath
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                .ToLowerInvariant();
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))[..32];
            return Path.Combine(cacheRootDir, $"{hash}.json");
        }

        /// <summary>Loads the last snapshot for <paramref name="folderPath"/>,
        /// keyed by bare file name (case-insensitive). Missing, unreadable, or
        /// malformed snapshots degrade to an empty map — this is a best-effort
        /// cache, never a source of truth, so a corrupt or absent file just
        /// means the fallback finds no missing-known-path candidates this
        /// scan, not a crash.</summary>
        public static IReadOnlyDictionary<string, RenameReconciliationLogic.Fingerprint> Load(
            string cacheRootDir, string folderPath)
        {
            var empty = new Dictionary<string, RenameReconciliationLogic.Fingerprint>(StringComparer.OrdinalIgnoreCase);
            var path = IndexPathFor(cacheRootDir, folderPath);
            try
            {
                if (!File.Exists(path)) return empty;
                var json = File.ReadAllText(path, Encoding.UTF8);
                var dto = JsonSerializer.Deserialize<IndexDto>(json);
                if (dto?.Files == null) return empty;

                var result = new Dictionary<string, RenameReconciliationLogic.Fingerprint>(StringComparer.OrdinalIgnoreCase);
                foreach (var entry in dto.Files)
                {
                    if (string.IsNullOrEmpty(entry.FileName)) continue;
                    result[entry.FileName] = new RenameReconciliationLogic.Fingerprint(
                        entry.Size, entry.CaptureTimeUtc, entry.CameraSerial);
                }
                return result;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                return empty;
            }
        }

        /// <summary>Atomically overwrites the snapshot for <paramref
        /// name="folderPath"/> with <paramref name="snapshot"/> — the same
        /// temp-file-then-move publish SidecarStore.Save uses, so a reader
        /// never observes a partially-written snapshot. Best-effort: a
        /// failure here only means the NEXT scan's fallback has stale data
        /// to diff against, never data loss for the photos themselves.
        /// </summary>
        public static void Save(
            string cacheRootDir, string folderPath,
            IReadOnlyDictionary<string, RenameReconciliationLogic.Fingerprint> snapshot)
        {
            Directory.CreateDirectory(cacheRootDir);
            var path = IndexPathFor(cacheRootDir, folderPath);
            var tempPath = $"{path}.{Guid.NewGuid():N}.tmp";
            try
            {
                var dto = new IndexDto
                {
                    Version = CurrentVersion,
                    Files = snapshot
                        .Select(kv => new IndexEntryDto
                        {
                            FileName = kv.Key,
                            Size = kv.Value.FileSizeBytes,
                            CaptureTimeUtc = kv.Value.CaptureTimeUtc,
                            CameraSerial = kv.Value.CameraSerial,
                        })
                        .ToList(),
                };
                File.WriteAllText(tempPath, JsonSerializer.Serialize(dto), Encoding.UTF8);
                File.Move(tempPath, path, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                TryDelete(tempPath);
            }
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Best-effort cleanup — the .tmp suffix makes strays identifiable.
            }
        }

        private sealed class IndexEntryDto
        {
            public string FileName { get; set; } = string.Empty;
            public long Size { get; set; }
            public DateTime? CaptureTimeUtc { get; set; }
            public string? CameraSerial { get; set; }
        }

        private sealed class IndexDto
        {
            public int Version { get; set; } = CurrentVersion;
            public List<IndexEntryDto> Files { get; set; } = new();
        }
    }
}
