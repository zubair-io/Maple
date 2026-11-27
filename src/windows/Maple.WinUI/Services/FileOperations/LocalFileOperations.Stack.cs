// LocalFileOperations.Stack.cs — a RAW+JPEG stack carried through relocate
// and trash (#5050, #5848). A stacked Library tile is the RAW; its same-stem
// JPEG follows it, so one action leaves neither file behind. The two share
// one XMP sidecar, which the shared-sidecar rule
// (`LocalFileOperations.SidecarOwnership.cs`) copies, never takes, until the
// last sibling leaves.
//
// One tile, two file operations. Every collision is decided before a byte is
// copied, both files are planned (copied and verified) before either source
// is deleted, and a collision choice made for the RAW never reaches the JPEG:
// a taken JPEG name refuses the pair under Fail and Replace alike, and Keep
// Both picks one name free for the RAW, the JPEG and their sidecar. Apple's
// twin is `LocalFileOperations+Stack.swift`.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        /// <summary>Relocate <paramref name="primaryPath"/> and its stacked
        /// JPEG together. Either both files land or the sources, and every
        /// file a Replace would have displaced, are left as they were.</summary>
        public static Task<RelocateOutcome> RelocateStackAsync(
            string primaryPath,
            string companionPath,
            string destinationDir,
            string? newBasename,
            RelocateMode mode,
            CollisionPolicy collision = CollisionPolicy.AutoSuffix) =>
            RelocateStackAsync(
                primaryPath, companionPath, destinationDir, newBasename, mode, collision,
                restoredName: false, pairedCopyCarry: PairedCopyCarry.None);

        internal static async Task<RelocateOutcome> RelocateStackAsync(
            string primaryPath,
            string companionPath,
            string destinationDir,
            string? newBasename,
            RelocateMode mode,
            CollisionPolicy collision,
            bool restoredName,
            PairedCopyCarry pairedCopyCarry)
        {
            RejectPairedCopiesWithReplace(pairedCopyCarry, collision);
            ThrowIfStackFileMissing(primaryPath, companionPath);
            if (newBasename != null) ValidateBareFileName(newBasename, restoredName);
            Directory.CreateDirectory(destinationDir);

            var pairedScan = pairedCopyCarry == PairedCopyCarry.None
                ? PairedCopyScan.None
                : ScanPairedCopies(primaryPath, new FolderListing(Path.GetDirectoryName(Path.GetFullPath(primaryPath)) ?? string.Empty));
            if (pairedCopyCarry == PairedCopyCarry.OutOfTrash) ThrowIfRestoreWouldStrand(pairedScan);
            var pair = new StackPair(
                primaryPath, companionPath, destinationDir, newBasename ?? Path.GetFileName(primaryPath),
                pairedCopyCarry, pairedScan, new FolderListing(Path.GetFullPath(destinationDir)));
            var primaryName = await ResolveStackNameAsync(pair, collision).ConfigureAwait(false);
            var primaryTarget = pair.PrimaryTarget(primaryName);
            var backups = collision == CollisionPolicy.Replace
                ? BackUpOccupants(
                    new[] { primaryTarget, SidecarStore.SidecarPathFor(primaryTarget) },
                    primaryPath, companionPath, SidecarStore.SidecarPathFor(primaryPath))
                : Array.Empty<DisplacedFile>();

            RelocatePlan primaryPlan;
            RelocatePlan? companionPlan;
            try
            {
                (primaryPlan, companionPlan) = await PlanStackAsync(pair, primaryName, mode, collision, keepsExistingName: restoredName || newBasename == null, pairedCopyCarry)
                    .ConfigureAwait(false);
            }
            catch
            {
                Restore(backups);
                throw;
            }

            var primary = FinalizeRelocate(primaryPlan);
            var companionFinalPath = companionPlan == null
                ? companionPath
                : FinalizeRelocate(companionPlan).PrimaryPath;
            Discard(backups);
            return primary with
            {
                RenamedDueToCollision = primary.RenamedDueToCollision
                    || !string.Equals(primaryName, pair.RequestedName, StringComparison.Ordinal),
                CompanionPath = companionFinalPath,
            };
        }

        /// <summary>Trash a stacked RAW with its JPEG. On a local fixed drive
        /// both files and their sidecar go to the Recycle Bin as one shell
        /// call; elsewhere, or when that call fails, both move to
        /// `.maple/trash/&lt;rel&gt;` under one free name.</summary>
        public static async Task<RelocateOutcome> TrashStackAsync(
            string primaryPath, string companionPath, string libraryRoot, IRecycleBinService? recycleBin = null)
        {
            ThrowIfStackFileMissing(primaryPath, companionPath);
            var sidecarPath = SidecarStore.SidecarPathFor(primaryPath);
            var hasSidecar = File.Exists(sidecarPath) && !SidecarStemClaimedBySibling(primaryPath, companionPath);
            var recycled = hasSidecar
                ? new[] { primaryPath, companionPath, sidecarPath }
                : new[] { primaryPath, companionPath };
            if (IsOnLocalFixedDrive(primaryPath))
            {
                if ((recycleBin ?? RecycleBinService.Instance).TrySendToRecycleBin(recycled))
                    return new RelocateOutcome(
                        primaryPath, hasSidecar ? sidecarPath : null, false, hasSidecar, companionPath);
                ThrowIfPartlyRecycled(recycled);
            }

            var trashDir = TrashPaths.TrashDestinationDir(primaryPath, libraryRoot);
            return await RelocateStackAsync(
                primaryPath, companionPath, trashDir, null, RelocateMode.Move, CollisionPolicy.AutoSuffix,
                restoredName: false, pairedCopyCarry: PairedCopyCarry.IntoTrash)
                .ConfigureAwait(false);
        }

        // The shell call can recycle some of the files and then fail on a
        // locked one; falling back to `.maple/trash` would then plan against
        // sources that are already gone.
        private static void ThrowIfPartlyRecycled(string[] sent)
        {
            var gone = sent.Where(path => !File.Exists(path)).Select(Path.GetFileName).ToArray();
            if (gone.Length == 0) return;
            var remaining = sent.Where(File.Exists).Select(Path.GetFileName).ToArray();
            var message = remaining.Length == 0
                ? $"The system reported an error, but every file of this RAW+JPEG pair is no longer in the folder "
                    + $"({string.Join(", ", gone)}). Check the Recycle Bin."
                : $"The system could not recycle every file of this RAW+JPEG pair. No longer in the folder, "
                    + $"probably in the Recycle Bin: {string.Join(", ", gone)}. "
                    + $"Still in the folder: {string.Join(", ", remaining)}.";
            throw new FileOperationException(FileOperationErrorKind.Underlying, message);
        }

        private sealed record StackPair(
            string Primary, string Companion, string DestinationDir, string RequestedName,
            PairedCopyCarry PairedCopyCarry, PairedCopyScan PairedScan, FolderListing Destination)
        {
            public string PrimaryTarget(string primaryName) => Path.Combine(DestinationDir, primaryName);

            public string CompanionTarget(string primaryName) => Path.Combine(
                DestinationDir,
                RawJpegPairing.CompanionFileName(
                    Path.GetFileName(Companion), Path.GetFileName(Primary), primaryName));

            public bool PrimaryOccupied(string primaryName)
            {
                var target = PrimaryTarget(primaryName);
                return !NamesSameFile(Primary, target)
                    && (AssetDestinationOccupied(target, SidecarStore.SidecarPathFor(Primary))
                        || (PairedCopyCarry != PairedCopyCarry.None
                            && AdoptableNameHeldByOther(
                                PairedScan, Primary, target, Destination.EntryNames, includeCanonical: false)));
            }

            // The shared sidecar is the RAW's to resolve, so only the JPEG's
            // own name counts here.
            public bool CompanionOccupied(string primaryName)
            {
                var target = CompanionTarget(primaryName);
                return !NamesSameFile(Companion, target) && PathOccupied(target);
            }
        }

        private sealed record DisplacedFile(string Backup, string Original, bool WasReadOnly);

        private static void ThrowIfStackFileMissing(params string[] sources)
        {
            var missing = sources.FirstOrDefault(source => !File.Exists(source));
            if (missing != null)
                throw new FileOperationException(FileOperationErrorKind.SourceMissing, missing);
        }

        private static bool NamesSameFile(string source, string target) =>
            ClassifySameFile(source, target) switch
            {
                SameFileClassification.Identical => true,
                SameFileClassification.CaseOnlyRename => FolderFoldsCaseBetween(source, target),
                _ => false,
            };

        private static async Task<string> ResolveStackNameAsync(StackPair pair, CollisionPolicy collision)
        {
            var name = pair.RequestedName;
            if (NamesSameFile(pair.Companion, pair.PrimaryTarget(name)))
                throw new FileOperationException(FileOperationErrorKind.DestinationExists, pair.PrimaryTarget(name));
            if (collision == CollisionPolicy.AutoSuffix)
            {
                var free = await CollisionResolver.PickFreePathAsync(
                    pair.PrimaryTarget(name),
                    candidate =>
                    {
                        var candidateName = Path.GetFileName(candidate);
                        return Task.FromResult(
                            pair.PrimaryOccupied(candidateName) || pair.CompanionOccupied(candidateName));
                    }).ConfigureAwait(false);
                return Path.GetFileName(free);
            }
            if (collision == CollisionPolicy.Fail && pair.PrimaryOccupied(name))
                throw new FileOperationException(FileOperationErrorKind.DestinationExists, pair.PrimaryTarget(name));
            if (pair.CompanionOccupied(name))
                throw new FileOperationException(FileOperationErrorKind.DestinationExists, pair.CompanionTarget(name));
            return name;
        }

        internal static string? CarriedSidecarFor(
            string companionSourceSidecar, string primarySourceSidecar, string? primaryFinalSidecar) =>
            SameSidecarPath(companionSourceSidecar, primarySourceSidecar) ? primaryFinalSidecar : null;

        private static async Task<(RelocatePlan Primary, RelocatePlan? Companion)> PlanStackAsync(
            StackPair pair, string primaryName, RelocateMode mode, CollisionPolicy collision, bool keepsExistingName,
            PairedCopyCarry pairedCopyCarry)
        {
            var companionTarget = pair.CompanionTarget(primaryName);
            var primaryPlan = await PlanRelocateAsync(
                pair.Primary, pair.DestinationDir, primaryName, mode,
                collision == CollisionPolicy.Replace ? CollisionPolicy.Replace : CollisionPolicy.Fail,
                carriedSidecarPath: null, alsoLeaving: Array.Empty<string>(), keepsExistingName, pairedCopyCarry)
                .ConfigureAwait(false);
            if (ClassifySameFile(pair.Companion, companionTarget) == SameFileClassification.Identical)
                return (primaryPlan, null);
            try
            {
                var companionPlan = await PlanRelocateAsync(
                    pair.Companion, pair.DestinationDir, Path.GetFileName(companionTarget), mode,
                    CollisionPolicy.Fail,
                    CarriedSidecarFor(
                        SidecarStore.SidecarPathFor(pair.Companion),
                        primaryPlan.SourceSidecarPath ?? SidecarStore.SidecarPathFor(pair.Primary),
                        primaryPlan.FinalSidecarPath),
                    new[] { pair.Primary }, keepsExistingName, pairedCopyCarry).ConfigureAwait(false);
                return (primaryPlan, companionPlan);
            }
            catch
            {
                await WithdrawAsync(primaryPlan, pair.Primary).ConfigureAwait(false);
                throw;
            }
        }

        /// <summary>Undo a RAW plan whose JPEG could not be planned. Staged
        /// copies are removed; a case-only rename already happened in place,
        /// so it is renamed back.</summary>
        private static async Task WithdrawAsync(RelocatePlan plan, string source)
        {
            if (!plan.SourceAlreadyRelocated)
            {
                RevertPlan(plan);
                return;
            }
            try
            {
                await PlanRelocateAsync(
                    plan.FinalPrimaryPath, Path.GetDirectoryName(source) ?? string.Empty,
                    Path.GetFileName(source), RelocateMode.Move, CollisionPolicy.Fail,
                    carriedSidecarPath: null, alsoLeaving: Array.Empty<string>(), restoredName: true).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is FileOperationException or IOException or UnauthorizedAccessException)
            {
                DiagLog.Write($"[FileOperations] could not rename {plan.FinalPrimaryPath} back to {source}: {ex.Message}");
            }
        }

        /// <summary>Verified copies of every regular file at
        /// <paramref name="paths"/> a Replace could displace, so a pair that
        /// fails half-way can put them back.</summary>
        private static IReadOnlyList<DisplacedFile> BackUpOccupants(IEnumerable<string> paths, params string[] sources)
        {
            var backups = new List<DisplacedFile>();
            try
            {
                foreach (var path in paths.Where(File.Exists)
                             .Where(path => !sources.Any(source => NamesSameFile(source, path))))
                {
                    var backup = TempPathFor(path);
                    var wasReadOnly = File.GetAttributes(path).HasFlag(FileAttributes.ReadOnly);
                    CopyVerified(path, backup);
                    backups.Add(new DisplacedFile(backup, path, wasReadOnly));
                    // A read-only backup could not be deleted once it is no longer needed.
                    if (wasReadOnly) File.SetAttributes(backup, File.GetAttributes(backup) & ~FileAttributes.ReadOnly);
                }
            }
            catch
            {
                Discard(backups);
                throw;
            }
            return backups;
        }

        private static void Restore(IReadOnlyList<DisplacedFile> backups)
        {
            foreach (var item in backups)
            {
                var moved = false;
                try
                {
                    // A read-only photo published by the failed plan would refuse the move.
                    if (File.Exists(item.Original))
                        File.SetAttributes(item.Original, File.GetAttributes(item.Original) & ~FileAttributes.ReadOnly);
                    File.Move(item.Backup, item.Original, overwrite: true);
                    moved = true;
                    if (item.WasReadOnly)
                        File.SetAttributes(item.Original, File.GetAttributes(item.Original) | FileAttributes.ReadOnly);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    DiagLog.Write(moved
                        ? $"[FileOperations] put back {item.Original}, but could not make it read-only again: {ex.Message}"
                        : $"[FileOperations] could not put back {item.Original}; "
                            + $"its copy is kept at {item.Backup}: {ex.Message}");
                }
            }
        }

        private static void Discard(IReadOnlyList<DisplacedFile> backups)
        {
            foreach (var item in backups)
            {
                TryDelete(item.Backup);
                if (File.Exists(item.Backup))
                    DiagLog.Write($"[FileOperations] could not remove the backup of {item.Original}: {item.Backup}");
            }
        }
    }
}
