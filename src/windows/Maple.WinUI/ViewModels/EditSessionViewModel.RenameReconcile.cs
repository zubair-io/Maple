// EditSessionViewModel.RenameReconcile.cs — closed-app external-rename
// fallback (#2657). The FileSystemWatcher live path
// (EditSessionViewModel.Watcher.cs) has zero false-positive risk: it
// follows the OS's own Renamed event directly. This file covers what that
// path structurally cannot — a rename that happened while Maple was
// closed, where the only evidence on the next scan is "a file Maple knew
// about is gone" and "a file Maple never saw before has appeared" in the
// same folder.
//
// All the actual decision logic (the diff, the fingerprint match, the
// exactly-one guard, never merging two photos on size alone) lives in the
// WinUI-free, xUnit-tested RenameReconciliationLogic
// (Services/FileOperations/RenameReconciliationLogic.cs) — this file is
// just the wiring: where the persisted per-folder snapshot lives on disk
// (RenameIndexStore, same directory, same test coverage), and how a
// confirmed match gets applied. Applying a match is just moving the
// sidecar — the fresh PhotoItem list LoadDirectory builds right after this
// runs picks up the relocated sidecar through the normal SidecarStore.Load
// call, so no separate identity-preserving update is needed the way the
// live watcher path requires (AllPhotos is rebuilt from scratch on every
// LoadDirectory call, unlike the live path's in-place mutation of items
// already sitting in the grid).
//
// No old-path thumbnail-cache cleanup here either, matching
// EditSessionViewModel.Watcher.cs's ApplyLiveRenames: that gap is #2710,
// tracked separately, not grown by this ticket.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        private static readonly string RenameIndexCacheDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Maple", "rename-index");

        /// <summary>Enumerates <paramref name="folderPath"/>'s image files
        /// and reconciles any closed-app external rename (#2657) before
        /// returning them, so a caller that then loads per-file sidecar
        /// state (LoadDirectory) already sees a relocated sidecar in
        /// place.</summary>
        private static List<string> EnumerateAndReconcile(string folderPath)
        {
            var filePaths = EnumerateImageFiles(folderPath).ToList();
            ReconcileExternalRenames(folderPath, filePaths);
            return filePaths;
        }

        /// <summary>Runs on the folder-scan background thread, BEFORE the
        /// grid's item list is built, so a reconciled sidecar is already in
        /// place by the time SidecarStore.Load runs for the new name. Cheap
        /// in the common case: EXIF is only read for "new unknown"
        /// candidates, and only once at least one previously-known file has
        /// actually gone missing (RenameReconciliationLogic.Reconcile
        /// short-circuits on both counts).</summary>
        private static void ReconcileExternalRenames(string folderPath, IReadOnlyList<string> currentFilePaths)
        {
            var previousSnapshot = RenameIndexStore.Load(RenameIndexCacheDir, folderPath);
            if (previousSnapshot.Count == 0)
                return;    // nothing to diff against — e.g. this folder's first-ever scan

            var currentFileNames = currentFilePaths
                .Select(Path.GetFileName)
                .Where(name => name != null)
                .Select(name => name!)
                .ToList();

            var reconciliations = RenameReconciliationLogic.Reconcile(
                previousSnapshot,
                currentFileNames,
                name => FingerprintOf(Path.Combine(folderPath, name)),
                message => DiagLog.Write($"[library] rename reconciliation declined: {message}"));

            foreach (var reconciliation in reconciliations)
                ApplyReconciledRename(folderPath, reconciliation);
        }

        /// <summary>Moves the vanished file's sidecar onto the file that
        /// replaced it. `overwrite: false` — a collision at the new sidecar
        /// path means something already occupies that name; silently
        /// clobbering it is worse than leaving this one orphaned.</summary>
        private static void ApplyReconciledRename(string folderPath, RenameReconciliationLogic.Reconciliation reconciliation)
        {
            try
            {
                var oldSidecar = SidecarStore.SidecarPathFor(Path.Combine(folderPath, reconciliation.MissingFileName));
                if (!File.Exists(oldSidecar))
                    return;    // nothing to carry across — no edits/rating existed to orphan
                var newSidecar = SidecarStore.SidecarPathFor(Path.Combine(folderPath, reconciliation.NewFileName));
                File.Move(oldSidecar, newSidecar, overwrite: false);
                DiagLog.Write(
                    $"[library] reconciled external rename: {reconciliation.MissingFileName} -> {reconciliation.NewFileName}");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                DiagLog.Write(
                    "[library] rename reconciliation sidecar move failed "
                    + $"{reconciliation.MissingFileName} -> {reconciliation.NewFileName}: {ex.Message}");
            }
        }

        private static RenameReconciliationLogic.Fingerprint? FingerprintOf(string filePath)
        {
            try
            {
                var info = new FileInfo(filePath);
                if (!info.Exists)
                    return null;
                var exif = ExifReader.Read(filePath);
                return new RenameReconciliationLogic.Fingerprint(info.Length, exif?.DateTimeOriginal, exif?.CameraSerial);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return null;
            }
        }

        /// <summary>Persists this folder's current fingerprints so the NEXT
        /// scan — including one after Maple restarts — has something to
        /// diff against. Called from HydrateLibraryAsync, which already
        /// reads EXIF per item for display; this reuses that read instead
        /// of a second pass over the folder.</summary>
        private static void SaveRenameSnapshot(
            string folderPath, IReadOnlyDictionary<string, RenameReconciliationLogic.Fingerprint> snapshot)
        {
            if (snapshot.Count == 0)
                return;
            RenameIndexStore.Save(RenameIndexCacheDir, folderPath, snapshot);
        }
    }
}
