// ExternalRenameReconciliationScanTests — real temp directories, real
// files. Ties RenameReconciliationLogic and RenameIndexStore together the
// same way EditSessionViewModel.RenameReconcile.cs's production wiring
// does (#2657's closed-app fallback), minus the WinUI-only pieces
// (PhotoItem, the ViewModel's folder scan) that can't link into this
// project. What this proves end-to-end, against a real filesystem: a
// folder scanned once, closed, externally renamed, and rescanned
// recognizes the rename via fingerprint and moves the sidecar to follow
// it — without ever touching the primary files, and without the two-
// candidate false-positive risk the acceptance criteria call out.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Services.Xmp;
using Xunit;

using Fingerprint = Maple.WinUI.Services.FileOperations.RenameReconciliationLogic.Fingerprint;

namespace Maple.WinUI.Tests
{
    public class ExternalRenameReconciliationScanTests : IDisposable
    {
        private readonly string _cacheDir;
        private readonly string _folderPath;

        public ExternalRenameReconciliationScanTests()
        {
            var root = Path.Combine(Path.GetTempPath(), "maple-winui-rename-scan-" + Guid.NewGuid().ToString("N"));
            _cacheDir = Path.Combine(root, "cache");
            _folderPath = Path.Combine(root, "library");
            Directory.CreateDirectory(_folderPath);
        }

        public void Dispose()
        {
            var root = Path.GetDirectoryName(_cacheDir)!;
            try { Directory.Delete(root, recursive: true); }
            catch (IOException) { }
        }

        private string WriteFile(string name, string content)
        {
            var full = Path.Combine(_folderPath, name);
            File.WriteAllText(full, content);
            return full;
        }

        /// <summary>Mirrors production's ComputeFingerprint minus the real
        /// EXIF read — content-independent capture time so the test controls
        /// which files "match" without needing real TIFF bytes.</summary>
        private static Fingerprint FingerprintOf(string filePath, DateTime? captureTime, string? serial) =>
            new(new FileInfo(filePath).Length, captureTime, serial);

        [Fact]
        public void RenameWhileClosed_SingleCandidate_ReconcilesAndMovesSidecar()
        {
            var captureTime = new DateTime(2026, 5, 1, 8, 0, 0, DateTimeKind.Utc);
            var oldPath = WriteFile("IMG_0001.CR3", "raw bytes, identical size before and after rename");
            WriteFile("IMG_0001.xmp", "<xmp/>original-edits");

            // Scan #1 (app open): persist what the folder looks like now.
            RenameIndexStore.Save(_cacheDir, _folderPath, new Dictionary<string, Fingerprint>
            {
                ["IMG_0001.CR3"] = FingerprintOf(oldPath, captureTime, "SN777"),
            });

            // App closes. Explorer renames the RAW; the sidecar does NOT
            // follow (nothing outside Maple knows the sidecar convention).
            var newPath = Path.Combine(_folderPath, "Wedding_001.CR3");
            File.Move(oldPath, newPath);

            // Scan #2 (app reopens): diff against the persisted snapshot.
            var previousSnapshot = RenameIndexStore.Load(_cacheDir, _folderPath);
            var currentNames = Directory.EnumerateFiles(_folderPath)
                .Select(Path.GetFileName)
                .Where(n => n != null && !n.EndsWith(".xmp", StringComparison.OrdinalIgnoreCase))
                .Select(n => n!)
                .ToList();

            var reconciliations = RenameReconciliationLogic.Reconcile(
                previousSnapshot, currentNames,
                name => FingerprintOf(Path.Combine(_folderPath, name), captureTime, "SN777"));

            var reconciliation = Assert.Single(reconciliations);
            Assert.Equal("IMG_0001.CR3", reconciliation.MissingFileName);
            Assert.Equal("Wedding_001.CR3", reconciliation.NewFileName);

            // Apply exactly what production's ApplyReconciledRename does.
            var oldSidecar = SidecarStore.SidecarPathFor(Path.Combine(_folderPath, reconciliation.MissingFileName));
            var newSidecar = SidecarStore.SidecarPathFor(Path.Combine(_folderPath, reconciliation.NewFileName));
            File.Move(oldSidecar, newSidecar);

            Assert.False(File.Exists(oldSidecar));
            Assert.Equal("<xmp/>original-edits", File.ReadAllText(newSidecar));
            // The primary was never touched by reconciliation — it already
            // sits at newPath from the external rename above.
            Assert.True(File.Exists(newPath));
        }

        [Fact]
        public void RenameWhileClosed_TwoSameFingerprintCandidates_DeclinesAndLeavesBothSidecarsAlone()
        {
            var captureTime = new DateTime(2026, 5, 1, 8, 0, 0, DateTimeKind.Utc);
            var oldPath = WriteFile("IMG_0001.CR3", "identical-size-payload-AAAA");
            var oldSidecarPath = WriteFile("IMG_0001.xmp", "<xmp/>original-edits");

            RenameIndexStore.Save(_cacheDir, _folderPath, new Dictionary<string, Fingerprint>
            {
                ["IMG_0001.CR3"] = FingerprintOf(oldPath, captureTime, "SN777"),
            });

            File.Delete(oldPath);
            // Two DIFFERENT photos land in the folder that happen to share
            // the same size/capture-time/serial fingerprint as the vanished
            // file — must never guess which one it became.
            WriteFile("candidate-a.CR3", "identical-size-payload-AAAA");
            WriteFile("candidate-b.CR3", "identical-size-payload-AAAA");

            var previousSnapshot = RenameIndexStore.Load(_cacheDir, _folderPath);
            var currentNames = new[] { "candidate-a.CR3", "candidate-b.CR3" };
            var declined = new List<string>();

            var reconciliations = RenameReconciliationLogic.Reconcile(
                previousSnapshot, currentNames,
                name => FingerprintOf(Path.Combine(_folderPath, name), captureTime, "SN777"),
                declined.Add);

            Assert.Empty(reconciliations);
            Assert.Single(declined);
            // Nothing was touched: the orphaned sidecar is still exactly
            // where it was, and neither candidate acquired edits it never
            // authored.
            Assert.True(File.Exists(oldSidecarPath));
            Assert.False(File.Exists(SidecarStore.SidecarPathFor(Path.Combine(_folderPath, "candidate-a.CR3"))));
            Assert.False(File.Exists(SidecarStore.SidecarPathFor(Path.Combine(_folderPath, "candidate-b.CR3"))));
        }

        [Fact]
        public void NoRenameHappened_NothingVanished_ProducesNoReconciliation()
        {
            var captureTime = new DateTime(2026, 5, 1, 8, 0, 0, DateTimeKind.Utc);
            var path = WriteFile("IMG_0001.CR3", "unchanged payload");
            RenameIndexStore.Save(_cacheDir, _folderPath, new Dictionary<string, Fingerprint>
            {
                ["IMG_0001.CR3"] = FingerprintOf(path, captureTime, "SN777"),
            });

            var previousSnapshot = RenameIndexStore.Load(_cacheDir, _folderPath);
            var currentNames = new[] { "IMG_0001.CR3" };

            var reconciliations = RenameReconciliationLogic.Reconcile(
                previousSnapshot, currentNames,
                name => FingerprintOf(Path.Combine(_folderPath, name), captureTime, "SN777"));

            Assert.Empty(reconciliations);
        }
    }
}
