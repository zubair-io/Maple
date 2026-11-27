// PairedCopySafetyTests — the edge cases of carrying a photo's edit copies
// through the Maple trash (#6133): size, links, joins, rollback and refusals.
// Real files; whole-tree comparisons by name and bytes.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class PairedCopySafetyTests : PairedEditCopiesFixture
    {
        private static string TooLongToStage => "photo (conflict from Z" + new string('z', 215) + ").xmp";

        private static string Large => new('w', (int)Maple.WinUI.Services.Xmp.SidecarStore.MaxSidecarBytes + 100);

        [Fact]
        public async Task ALargeWorkflowCopy_TravelsIntoTheTrashAndBack()
        {
            WriteEach(Root, "photo.dng", Conflict);
            File.WriteAllText(InRoot(Workflow), Large);
            var before = Tree();

            await TrashAsync("photo.dng");
            Assert.Equal(Large, File.ReadAllText(InTrash(Workflow)));
            Assert.Equal(before.Count, Tree().Count);
            await RestoreAsync("photo.dng");

            AssertTree(before, Tree());
        }

        [Fact]
        public async Task ALargeWorkflowCopyOfAStack_IsJoinedByTheJpegAndTravelsOnce()
        {
            WriteEach(Root, "photo.cr3", "photo.jpg", "photo.xmp");
            File.WriteAllText(InRoot(Workflow), Large);
            var before = Tree();

            await TrashAsync("photo.cr3", companion: "photo.jpg");
            Assert.Equal(Large, File.ReadAllText(InTrash(Workflow)));
            Assert.Empty(Directory.EnumerateFiles(Root));
            await RestoreAsync("photo.cr3");

            AssertTree(before, Tree());
        }

        [Fact]
        public async Task ARollbackSparesTheFileItJoinedInsteadOfCreating()
        {
            WriteEach(Root, "photo.dng", Conflict, TooLongToStage);
            WriteEach(TrashDir, Conflict);
            var before = Tree(withMarkers: true);

            var results = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(InRoot("photo.dng"), InRoot("photo.dng"), "photo.dng") },
                _ => Root, new FakeRecycleBinService { Succeeds = false });

            Assert.Equal(TrashOutcomeKind.Error, Assert.Single(results).Kind);
            AssertTree(before, Tree(withMarkers: true));
        }

        [Fact]
        public async Task AStackWhoseJpegFailsAfterTheRawPublished_PutsEverythingBack()
        {
            WriteEach(Root, "photo.cr3", "photo.jpg", "photo.xmp", Conflict, Workflow);
            var before = Tree(withMarkers: true);

            IReadOnlyList<TrashItemOutcome> results;
            using (new FileStream(InRoot("photo.jpg"), FileMode.Open, FileAccess.Read, FileShare.None))
            {
                results = await TrashSelectionLogic.ApplySequentialAsync(
                    new[] { new TrashSourceItem(InRoot("photo.cr3"), InRoot("photo.cr3"), "photo.cr3", InRoot("photo.jpg")) },
                    _ => Root, new FakeRecycleBinService { Succeeds = false });
            }

            Assert.Equal(TrashOutcomeKind.Error, Assert.Single(results).Kind);
            AssertTree(before, Tree(withMarkers: true));
        }

        [Fact]
        public async Task AStackTrashedBeforeCopiesTravelled_RestoresBesideItsLeftBehindCopiesUntouched()
        {
            WriteEach(TrashDir, "photo.cr3", "photo.jpg", "photo.xmp");
            LocalFileOperations.TryWriteOriginalPathMarker(InTrash("photo.cr3"), "photo.cr3");
            LocalFileOperations.TryWriteOriginalPathMarker(InTrash("photo.jpg"), "photo.jpg");
            WriteEach(Root, Conflict, Workflow);

            var outcome = await RestoreAsync("photo.cr3");

            Assert.Equal(InRoot("photo.restored.cr3"), outcome.PrimaryPath);
            AssertTree(
                new Dictionary<string, string>
                {
                    [Conflict] = BytesOf(Conflict),
                    [Workflow] = BytesOf(Workflow),
                    ["photo.restored.cr3"] = BytesOf("photo.cr3"),
                    ["photo.restored.jpg"] = BytesOf("photo.jpg"),
                    ["photo.restored.xmp"] = BytesOf("photo.xmp"),
                },
                Tree());
        }

        [Fact]
        public async Task AVideoWithItsCopies_RoundTripsThroughTheTrash()
        {
            WriteEach(Root, "clip.mov", "clip.mov.xmp", "clip.mov (conflict from Mac).xmp", "clip.mov.v12345678-1234-1234-1234-123456789abc.xmp");
            var before = Tree();

            await TrashAsync("clip.mov");
            Assert.Equal(4, Tree().Keys.Count(key => key.StartsWith(".maple/trash/")));
            await RestoreAsync("clip.mov");

            AssertTree(before, Tree());
        }

        [Fact]
        public async Task ALinkBesideTheTrashedPhoto_RefusesTheRestoreBeforeAnythingMoves()
        {
            WriteEach(TrashDir, "photo.dng", "photo.xmp");
            LocalFileOperations.TryWriteOriginalPathMarker(InTrash("photo.dng"), "photo.dng");
            File.WriteAllText(InRoot("outside.xmp"), "outside");
            File.CreateSymbolicLink(InTrash(Conflict), InRoot("outside.xmp"));
            var before = Tree(withMarkers: true);

            var refused = await Assert.ThrowsAsync<FileOperationException>(() => RestoreAsync("photo.dng"));

            Assert.Contains(Conflict, refused.Message);
            AssertTree(before, Tree(withMarkers: true));
            Assert.NotNull(new FileInfo(InTrash(Conflict)).LinkTarget);
        }

        [Fact]
        public async Task ALinkBesideAPhotoGoingToTheTrash_StaysWhereItIsAndTheRestIsCarried()
        {
            WriteEach(Root, "photo.dng", Workflow);
            File.WriteAllText(InRoot("outside.xmp"), "outside");
            File.CreateSymbolicLink(InRoot(Conflict), InRoot("outside.xmp"));

            await TrashAsync("photo.dng");

            Assert.NotNull(new FileInfo(InRoot(Conflict)).LinkTarget);
            Assert.True(File.Exists(InRoot("outside.xmp")));
            Assert.True(File.Exists(InTrash(Workflow)));
            Assert.False(File.Exists(InTrash(Conflict)));
        }

        [Fact]
        public async Task CarryingEditCopiesIsRefusedWithAPolicyThatReplaces()
        {
            WriteEach(Root, "photo.dng", Conflict);
            WriteEach(InRoot("out"), "photo.dng");
            var before = Tree();

            await Assert.ThrowsAsync<ArgumentException>(() => LocalFileOperations.PlanRelocateAsync(
                InRoot("photo.dng"), InRoot("out"), null, RelocateMode.Move, CollisionPolicy.Replace,
                carriedSidecarPath: null, alsoLeaving: Array.Empty<string>(),
                restoredName: false, pairedCopyCarry: PairedCopyCarry.IntoTrash));
            await Assert.ThrowsAsync<ArgumentException>(() => LocalFileOperations.RelocateStackAsync(
                InRoot("photo.dng"), InRoot("photo.jpg"), InRoot("out"), null, RelocateMode.Move,
                CollisionPolicy.Replace, restoredName: false, pairedCopyCarry: PairedCopyCarry.IntoTrash));

            AssertTree(before, Tree());
        }
    }
}
