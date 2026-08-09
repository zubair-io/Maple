// RenameIndexStoreTests — real temp directories, real files. Covers the
// persisted per-folder fingerprint snapshot backing the #2657 closed-app
// rename fallback: round-trip fidelity, the atomic-write contract
// (SidecarStore's temp-file-then-move pattern), and graceful degradation on
// a missing or corrupt snapshot — this is a best-effort cache, so neither
// case should ever throw.

using System;
using System.Collections.Generic;
using System.IO;
using Maple.WinUI.Services.FileOperations;
using Xunit;

using Fingerprint = Maple.WinUI.Services.FileOperations.RenameReconciliationLogic.Fingerprint;

namespace Maple.WinUI.Tests
{
    public class RenameIndexStoreTests : IDisposable
    {
        private readonly string _cacheDir;
        private readonly string _folderPath;

        public RenameIndexStoreTests()
        {
            var root = Path.Combine(Path.GetTempPath(), "maple-winui-rename-index-" + Guid.NewGuid().ToString("N"));
            _cacheDir = Path.Combine(root, "cache");
            _folderPath = Path.Combine(root, "library", "2026-05-01");
            Directory.CreateDirectory(_folderPath);
        }

        public void Dispose()
        {
            var root = Path.GetDirectoryName(_cacheDir)!;
            try { Directory.Delete(root, recursive: true); }
            catch (IOException) { }
        }

        [Fact]
        public void Load_WithNoSnapshotYet_ReturnsEmpty()
        {
            var loaded = RenameIndexStore.Load(_cacheDir, _folderPath);

            Assert.Empty(loaded);
        }

        [Fact]
        public void SaveThenLoad_RoundTripsFingerprintsExactly()
        {
            var captureTime = new DateTime(2026, 5, 1, 9, 30, 0, DateTimeKind.Utc);
            var snapshot = new Dictionary<string, Fingerprint>
            {
                ["IMG_0001.CR3"] = new Fingerprint(12_345_678, captureTime, "SN00042"),
                ["IMG_0002.CR3"] = new Fingerprint(9_000_000, null, null),
            };

            RenameIndexStore.Save(_cacheDir, _folderPath, snapshot);
            var loaded = RenameIndexStore.Load(_cacheDir, _folderPath);

            Assert.Equal(2, loaded.Count);
            Assert.Equal(new Fingerprint(12_345_678, captureTime, "SN00042"), loaded["IMG_0001.CR3"]);
            Assert.Equal(new Fingerprint(9_000_000, null, null), loaded["IMG_0002.CR3"]);
        }

        [Fact]
        public void Load_FileNameLookupIsCaseInsensitive()
        {
            var snapshot = new Dictionary<string, Fingerprint>
            {
                ["IMG_0001.CR3"] = new Fingerprint(100, null, "SN1"),
            };
            RenameIndexStore.Save(_cacheDir, _folderPath, snapshot);

            var loaded = RenameIndexStore.Load(_cacheDir, _folderPath);

            Assert.True(loaded.ContainsKey("img_0001.cr3"));
        }

        [Fact]
        public void Save_OverwritesPreviousSnapshotForTheSameFolder()
        {
            RenameIndexStore.Save(_cacheDir, _folderPath, new Dictionary<string, Fingerprint>
            {
                ["old.dng"] = new Fingerprint(1, null, null),
            });

            RenameIndexStore.Save(_cacheDir, _folderPath, new Dictionary<string, Fingerprint>
            {
                ["new.dng"] = new Fingerprint(2, null, null),
            });

            var loaded = RenameIndexStore.Load(_cacheDir, _folderPath);

            Assert.False(loaded.ContainsKey("old.dng"));
            Assert.True(loaded.ContainsKey("new.dng"));
        }

        [Fact]
        public void Save_LeavesNoTempFileBehind()
        {
            RenameIndexStore.Save(_cacheDir, _folderPath, new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(1, null, null),
            });

            var leftovers = Directory.GetFiles(_cacheDir, "*.tmp");
            Assert.Empty(leftovers);
        }

        [Fact]
        public void DifferentFolders_GetIndependentSnapshots()
        {
            var otherFolder = Path.Combine(Path.GetDirectoryName(_folderPath)!, "2026-05-02");
            Directory.CreateDirectory(otherFolder);

            RenameIndexStore.Save(_cacheDir, _folderPath, new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(1, null, null),
            });
            RenameIndexStore.Save(_cacheDir, otherFolder, new Dictionary<string, Fingerprint>
            {
                ["b.dng"] = new Fingerprint(2, null, null),
            });

            Assert.True(RenameIndexStore.Load(_cacheDir, _folderPath).ContainsKey("a.dng"));
            Assert.True(RenameIndexStore.Load(_cacheDir, otherFolder).ContainsKey("b.dng"));
        }

        [Fact]
        public void Load_WithCorruptJson_DegradesToEmptyRatherThanThrowing()
        {
            var path = RenameIndexStore.IndexPathFor(_cacheDir, _folderPath);
            Directory.CreateDirectory(_cacheDir);
            File.WriteAllText(path, "{ not valid json ");

            var loaded = RenameIndexStore.Load(_cacheDir, _folderPath);

            Assert.Empty(loaded);
        }

        [Fact]
        public void IndexPathFor_IsCaseAndTrailingSlashInsensitiveForTheSameFolder()
        {
            var a = RenameIndexStore.IndexPathFor(_cacheDir, _folderPath);
            var b = RenameIndexStore.IndexPathFor(_cacheDir, _folderPath.ToUpperInvariant() + "\\");

            Assert.Equal(a, b);
        }
    }
}
