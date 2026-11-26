// LocalFileOperations.ExternalRename.cs — the sidecar follow-up for photos
// renamed outside Maple while their folder is open (#6072). The watcher
// reports a rename after the file system already did it, so the old primary
// is gone and the folder shows the state AFTER the whole batch. The
// shared-sidecar rule (docs/xmp-canonical-format.md § "Moving, renaming and
// trashing a photo") still decides what each sidecar does:
//   - a file that arrived at its name through this batch never claims the
//     sidecar that name reads (it is the batch's own rename, not a sibling);
//   - a group whose new sidecar name is another group's old one runs after
//     that group; when no such order exists (a swap or rotation finished
//     inside one watcher window) no sidecar of those groups is touched.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    public enum ExternalRenameSidecarOutcome
    {
        NoSidecar,
        Carried,
        Joined,
        LeftInPlace,
        Collision,
        Failed,
        Skipped,
    }

    /// <summary><paramref name="ReadsOtherSidecar"/> is true when the renamed
    /// photo now reads a sidecar that is not the one it had (a collision, or
    /// no sidecar of its own while another already sits at its new name): any
    /// edits the app holds in memory for it are stale.</summary>
    public readonly record struct ExternalRenameSidecarResult(
        string OldPath, string NewPath, ExternalRenameSidecarOutcome Outcome, bool ReadsOtherSidecar);

    public static partial class LocalFileOperations
    {
        internal enum ExternalTargetState { Self, Duplicate, Join, Collision, Free }

        internal sealed class ExternalSidecarGroup
        {
            public required string OldSidecar { get; init; }
            public required IReadOnlyList<int> Indices { get; init; }
            public required IReadOnlyList<string> Targets { get; init; }
            public required IReadOnlyList<bool> SelfMapped { get; init; }
            public required bool Claimed { get; init; }
            public bool Stays => Claimed || SelfMapped.Contains(true);
        }

        /// <summary>Applies the shared-sidecar rule to renames that already
        /// happened on disk. Renames that read the same old sidecar are decided
        /// together, from the folder as it was before any step ran: the sidecar
        /// is copied to every new name, and the old one goes (moved to the last
        /// name) only when no other photo still reads it, nothing collided and
        /// no new name maps back onto it. Nothing is ever overwritten; a
        /// failure is logged and leaves every file where it was.</summary>
        public static IReadOnlyList<ExternalRenameSidecarResult> FollowExternalRenames(
            IReadOnlyList<(string OldPath, string NewPath)> renames)
        {
            var outcomes = Enumerable.Repeat(ExternalRenameSidecarOutcome.NoSidecar, renames.Count).ToArray();
            var groups = GroupExternalRenames(renames);
            var byOldSidecar = groups.ToLookup(g => g.OldSidecar, StringComparer.OrdinalIgnoreCase);
            var blockers = groups.ToDictionary(g => g, g => BlockingGroups(g, byOldSidecar));
            var done = new HashSet<ExternalSidecarGroup>();
            var pending = groups.ToList();
            while (pending.Find(g => blockers[g].All(done.Contains)) is { } ready)
            {
                FollowDirect(ready, outcomes);
                done.Add(ready);
                pending.Remove(ready);
            }
            if (pending.Count > 0)
            {
                DiagLog.Write("[library] sidecars left where they are: these renames swap or rotate names inside one "
                    + "watcher window, so no order settles them: "
                    + string.Join(", ", pending.SelectMany(g => g.Indices).Select(i => $"{renames[i].OldPath} -> {renames[i].NewPath}")));
                foreach (var index in pending.SelectMany(g => g.Indices))
                    outcomes[index] = ExternalRenameSidecarOutcome.Skipped;
            }

            return renames
                .Select((r, i) => new ExternalRenameSidecarResult(
                    r.OldPath, r.NewPath, outcomes[i], ReadsOtherSidecar(outcomes[i], r.NewPath)))
                .ToList();
        }

        private static bool ReadsOtherSidecar(ExternalRenameSidecarOutcome outcome, string newPath) =>
            outcome is ExternalRenameSidecarOutcome.Collision
            || (outcome is ExternalRenameSidecarOutcome.NoSidecar or ExternalRenameSidecarOutcome.Failed
                    or ExternalRenameSidecarOutcome.Skipped
                && File.Exists(SidecarStore.SidecarPathFor(newPath)));

        private static List<ExternalSidecarGroup> GroupExternalRenames(IReadOnlyList<(string OldPath, string NewPath)> renames)
        {
            var batchNewPaths = renames.Select(r => Path.GetFullPath(r.NewPath)).ToHashSet(StringComparer.Ordinal);
            var listings = new Dictionary<string, ILookup<string, string>?>(StringComparer.Ordinal);
            var clusters = renames
                .Select((r, i) => (Index: i, OldSidecar: SidecarStore.SidecarPathFor(r.OldPath)))
                .GroupBy(x => x.OldSidecar, StringComparer.OrdinalIgnoreCase)
                .SelectMany(bucket => ClusterBySidecarIdentity(bucket.ToList()));

            return clusters
                .Where(c => File.Exists(c[0].OldSidecar))
                .Select(c =>
                {
                    var targets = c.Select(x => SidecarStore.SidecarPathFor(renames[x.Index].NewPath)).ToList();
                    return new ExternalSidecarGroup
                    {
                        OldSidecar = c[0].OldSidecar,
                        Indices = c.Select(x => x.Index).ToList(),
                        Targets = targets,
                        SelfMapped = targets.Select(t => SameSidecarFile(c[0].OldSidecar, t)).ToList(),
                        Claimed = StemClaimedOutsideBatch(renames[c[0].Index].OldPath, batchNewPaths, listings),
                    };
                })
                .ToList();
        }

        private static IEnumerable<List<(int Index, string OldSidecar)>> ClusterBySidecarIdentity(
            List<(int Index, string OldSidecar)> sameSpellingIgnoringCase)
        {
            var clusters = new List<List<(int Index, string OldSidecar)>>();
            foreach (var item in sameSpellingIgnoringCase)
            {
                var cluster = clusters.Find(c => string.Equals(c[0].OldSidecar, item.OldSidecar, StringComparison.Ordinal)
                    || SameSidecarPath(c[0].OldSidecar, item.OldSidecar));
                if (cluster == null) clusters.Add(new() { item });
                else cluster.Add(item);
            }
            return clusters;
        }

        /// <summary>The old and new sidecar are one file when the names differ
        /// only in case and the folder folds case, or when the new name is
        /// occupied yet the folder's own listing does not show both names as
        /// entries (a folder that treats two spellings, such as composed and
        /// decomposed accents, as one name).</summary>
        private static bool SameSidecarFile(string a, string b) =>
            string.Equals(Path.GetFileName(a), Path.GetFileName(b), StringComparison.OrdinalIgnoreCase)
                ? SameSidecarPath(a, b)
                : PathOccupied(b) && !ListedAsSeparateEntries(a, b);

        /// <summary>True only when the folder lists both exact names as
        /// separate entries. A single entry for the two spellings means the
        /// folder reads them as one file, and so does a listing that cannot
        /// be read: neither may ever be taken for a second sidecar.</summary>
        internal static bool ListedAsSeparateEntries(string a, string b)
        {
            try
            {
                var (dirA, dirB) = (Path.GetDirectoryName(Path.GetFullPath(a)), Path.GetDirectoryName(Path.GetFullPath(b)));
                if (!string.Equals(dirA, dirB, StringComparison.Ordinal)) return !SameSidecarPath(a, b);
                var (nameA, nameB) = (Path.GetFileName(a), Path.GetFileName(b));
                if (dirA == null || string.Equals(nameA, nameB, StringComparison.Ordinal)) return false;
                var names = Directory.EnumerateFileSystemEntries(dirA).Select(Path.GetFileName).ToHashSet(StringComparer.Ordinal);
                return names.Contains(nameA) && names.Contains(nameB);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return false;
            }
        }

        private static string FoldedStem(string stem) => stem.Normalize(NormalizationForm.FormC).ToUpperInvariant();

        /// <summary>Lists each folder once and indexes its media files by
        /// folded stem, so a batch of hundreds of renames asks the ownership
        /// helper (which lists the folder itself) only about the few stems
        /// that a case or Unicode variant might still share.</summary>
        private static bool StemClaimedOutsideBatch(
            string oldPrimaryPath, HashSet<string> batchNewPaths, Dictionary<string, ILookup<string, string>?> listings)
        {
            var full = Path.GetFullPath(oldPrimaryPath);
            var dir = Path.GetDirectoryName(full);
            if (dir == null) return false;
            if (!listings.TryGetValue(dir, out var byStem))
            {
                try
                {
                    byStem = Directory.EnumerateFiles(dir)
                        .Select(Path.GetFileName)
                        .Where(name => !name!.StartsWith('.') && !StagingName.IsMatch(name) && IsMediaFile(name)
                            && !batchNewPaths.Contains(Path.Combine(dir, name)))
                        .ToLookup(name => FoldedStem(SidecarStemOf(name!)), name => name!);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    byStem = null;
                }
                listings[dir] = byStem;
            }
            if (byStem == null) return true;

            var stem = SidecarStemOf(Path.GetFileName(full));
            var candidates = byStem[FoldedStem(stem)]
                .Where(name => !string.Equals(Path.Combine(dir, name), full, StringComparison.Ordinal))
                .ToList();
            if (candidates.Count == 0) return false;
            if (candidates.Any(name => string.Equals(SidecarStemOf(name), stem, StringComparison.Ordinal))) return true;
            return SidecarStemClaimedBySibling(oldPrimaryPath, batchNewPaths.ToArray());
        }

        private static List<ExternalSidecarGroup> BlockingGroups(
            ExternalSidecarGroup group, ILookup<string, ExternalSidecarGroup> byOldSidecar) =>
            group.Targets.Where((_, i) => !group.SelfMapped[i])
                .SelectMany(target => byOldSidecar[target]
                    .Where(other => !ReferenceEquals(other, group) && !other.Stays && SameSidecarPath(target, other.OldSidecar)))
                .Distinct()
                .ToList();

        internal static ExternalTargetState[] ClassifyExternalTargets(ExternalSidecarGroup group)
        {
            var firstSeen = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            return group.Targets.Select((target, i) =>
            {
                if (group.SelfMapped[i]) return ExternalTargetState.Self;
                if (firstSeen.TryGetValue(target, out var first))
                    return string.Equals(group.Targets[first], target, StringComparison.Ordinal)
                        ? ExternalTargetState.Duplicate
                        : ExternalTargetState.Collision;
                firstSeen[target] = i;
                if (!PathOccupied(target)) return ExternalTargetState.Free;
                if (!ListedAsSeparateEntries(group.OldSidecar, target)) return ExternalTargetState.Self;
                return SidecarAlreadyCarried(group.OldSidecar, target)
                    ? ExternalTargetState.Join
                    : ExternalTargetState.Collision;
            }).ToArray();
        }

        internal static List<string> FreeExternalTargets(ExternalSidecarGroup group, ExternalTargetState[] states) =>
            group.Targets.Where((_, i) => states[i] == ExternalTargetState.Free).ToList();

        internal static void AssignExternalOutcomes(
            ExternalSidecarGroup group, ExternalTargetState[] states, ICollection<string> created,
            ExternalRenameSidecarOutcome[] outcomes)
        {
            for (var i = 0; i < states.Length; i++)
            {
                var target = group.Targets[i];
                if (states[i] == ExternalTargetState.Collision)
                    DiagLog.Write($"[library] sidecar kept at {group.OldSidecar}: {target} already belongs to another photo");
                outcomes[group.Indices[i]] = states[i] switch
                {
                    ExternalTargetState.Self => ExternalRenameSidecarOutcome.LeftInPlace,
                    ExternalTargetState.Join => ExternalRenameSidecarOutcome.Joined,
                    ExternalTargetState.Collision => ExternalRenameSidecarOutcome.Collision,
                    ExternalTargetState.Duplicate => outcomes[group.Indices[group.Targets
                        .Select((t, k) => (t, k)).First(x => x.k < i && string.Equals(x.t, target, StringComparison.OrdinalIgnoreCase)).k]],
                    _ => created.Contains(target) ? ExternalRenameSidecarOutcome.Carried : ExternalRenameSidecarOutcome.Failed,
                };
            }
        }

        private static void FollowDirect(ExternalSidecarGroup group, ExternalRenameSidecarOutcome[] outcomes)
        {
            if (group.SelfMapped.All(self => self))
            {
                RecaseSidecar(group, outcomes);
                return;
            }

            var states = ClassifyExternalTargets(group);
            var vacate = !group.Stays && !states.Contains(ExternalTargetState.Collision)
                && !states.Contains(ExternalTargetState.Self);
            var free = FreeExternalTargets(group, states);
            var created = new List<string>();
            try
            {
                var soleTarget = states.Count(state => state is ExternalTargetState.Free or ExternalTargetState.Join) == 1;
                if (vacate && soleTarget && free.Count == 1)
                {
                    File.Move(group.OldSidecar, free[0], overwrite: false);
                    created.Add(free[0]);
                }
                else
                {
                    foreach (var target in free)
                    {
                        try
                        {
                            CopyVerified(group.OldSidecar, target, overwrite: false);
                            created.Add(target);
                        }
                        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FileOperationException)
                        {
                            DiagLog.Write($"[library] sidecar {group.OldSidecar} could not be copied to {target}: {ex.Message}");
                        }
                    }
                    var everyTargetHoldsTheBytes = group.Targets
                        .Where((_, i) => states[i] is ExternalTargetState.Free or ExternalTargetState.Join)
                        .All(target => ListedAsSeparateEntries(group.OldSidecar, target)
                            && SidecarAlreadyCarried(group.OldSidecar, target));
                    if (vacate && everyTargetHoldsTheBytes) TryDeleteLogged(group.OldSidecar, "sidecar");
                    else if (vacate)
                        DiagLog.Write($"[library] sidecar {group.OldSidecar} kept: not every new sidecar is a separate file holding its bytes");
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FileOperationException)
            {
                DiagLog.Write($"[library] sidecar {group.OldSidecar} could not follow its photo: {ex.Message}");
            }
            AssignExternalOutcomes(group, states, created, outcomes);
        }

        /// <summary>Names that differ only in case read one file. The in-app
        /// case-only rename re-cases the sidecar unless a sibling shares it;
        /// so does this.</summary>
        private static void RecaseSidecar(ExternalSidecarGroup group, ExternalRenameSidecarOutcome[] outcomes)
        {
            var spellings = group.Targets.Distinct(StringComparer.Ordinal).ToList();
            var recase = !group.Claimed && spellings.Count == 1
                && !string.Equals(spellings[0], group.OldSidecar, StringComparison.Ordinal)
                && string.Equals(Path.GetFileName(spellings[0]), Path.GetFileName(group.OldSidecar), StringComparison.OrdinalIgnoreCase);
            var outcome = ExternalRenameSidecarOutcome.LeftInPlace;
            try
            {
                if (recase)
                {
                    File.Move(group.OldSidecar, spellings[0]);
                    outcome = ExternalRenameSidecarOutcome.Carried;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                DiagLog.Write($"[library] sidecar {group.OldSidecar} could not be re-cased: {ex.Message}");
            }
            foreach (var index in group.Indices) outcomes[index] = outcome;
        }
    }
}
