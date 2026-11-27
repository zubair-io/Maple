// RestorePairedEditCopiesTests — restoring from `.maple/trash` brings the
// photo's conflict and workflow edit copies back under the restored stem, all
// or nothing, and never overwrites a file (#6133). Real files in a temp
// library; assertions compare the whole tree by name and bytes.

using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RestorePairedEditCopiesTests : PairedEditCopiesFixture
    {
        private static string TooLongToStage => "photo (conflict from Z" + new string('z', 215) + ").xmp";

        private static Dictionary<string, string> Merge(params IEnumerable<KeyValuePair<string, string>>[] parts) =>
            parts.SelectMany(part => part).ToDictionary(pair => pair.Key, pair => pair.Value);

        private void PlaceInTrash(string originalRelativePath, params string[] names)
        {
            WriteEach(TrashDir, names);
            LocalFileOperations.TryWriteOriginalPathMarker(InTrash(names[0]), originalRelativePath);
        }

        [Fact]
        public async Task RoundTrip_PutsEveryFileBackUnderItsOwnNameAndEmptiesTheTrash()
        {
            WriteEach(Root, "photo.dng", "photo.xmp", Conflict, NumberedConflict, Workflow, "photo (2).xmp", "photo.v2.xmp");
            var before = Tree();
            await TrashAsync("photo.dng");

            var outcome = await RestoreAsync("photo.dng");

            Assert.Equal(InRoot("photo.dng"), outcome.PrimaryPath);
            AssertTree(before, Tree(withMarkers: true));
            Assert.Empty(Directory.EnumerateFiles(TrashDir, "*", SearchOption.AllDirectories));
        }

        [Fact]
        public async Task ATakenName_MovesThePhotoAndEveryCopyToTheRestoredStem()
        {
            WriteEach(Root, "photo.dng", "photo.xmp", Conflict, NumberedConflict, Workflow);
            await TrashAsync("photo.dng");
            File.WriteAllText(InRoot("photo.dng"), "occupant");

            var outcome = await RestoreAsync("photo.dng");

            Assert.Equal(InRoot("photo.restored.dng"), outcome.PrimaryPath);
            AssertTree(
                new Dictionary<string, string>
                {
                    ["photo.dng"] = "occupant",
                    ["photo.restored.dng"] = BytesOf("photo.dng"),
                    ["photo.restored.xmp"] = BytesOf("photo.xmp"),
                    ["photo.restored (conflict from Mac).xmp"] = BytesOf(Conflict),
                    ["photo.restored (conflict from Mac) (2).xmp"] = BytesOf(NumberedConflict),
                    ["photo.restored.v12345678-1234-1234-1234-123456789abc.xmp"] = BytesOf(Workflow),
                },
                Tree());
        }

        [Fact]
        public async Task ACopyThatAppearsAtItsNameAfterTheNameWasResolved_RollsBackAndChangesNothing()
        {
            WriteEach(Root, "photo.dng", "photo.xmp", Conflict, Workflow);
            await TrashAsync("photo.dng");
            var trashed = InTrash("photo.dng");
            var resolved = LocalFileOperations.ResolveRestoredBasename(trashed, Root, "photo.dng");
            Assert.Equal("photo.dng", resolved);
            File.WriteAllText(InRoot(Conflict), "late arrival");
            var before = Tree(withMarkers: true);

            var refused = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.MoveToRestoredNameAsync(trashed, Root, resolved));

            Assert.Equal(FileOperationErrorKind.DestinationExists, refused.Kind);
            AssertTree(before, Tree(withMarkers: true));
        }

        [Fact]
        public async Task ACopyThatFailsMidRestore_LeavesTheFolderAndTheTrashByteIdentical()
        {
            PlaceInTrash("photo.dng", "photo.dng", "photo.xmp", Conflict, TooLongToStage, Workflow);
            var before = Tree(withMarkers: true);

            var failure = await Record.ExceptionAsync(
                () => LocalFileOperations.RestoreFromMapleTrashAsync(InTrash("photo.dng"), Root));

            Assert.IsType<FileOperationException>(failure);
            AssertTree(before, Tree(withMarkers: true));
        }

        [Fact]
        public async Task AStackWhoseCopyFailsMidRestore_LeavesBothHalvesInTheTrash()
        {
            PlaceInTrash("photo.cr3", "photo.cr3", "photo.xmp", Conflict, TooLongToStage);
            PlaceInTrash("photo.jpg", "photo.jpg");
            var before = Tree(withMarkers: true);

            var failure = await Record.ExceptionAsync(
                () => LocalFileOperations.RestoreFromMapleTrashAsync(InTrash("photo.jpg"), Root));

            Assert.IsType<FileOperationException>(failure);
            AssertTree(before, Tree(withMarkers: true));
        }

        [Fact]
        public async Task AStackRestoresWithItsSharedCopiesWhicheverHalfIsNamed()
        {
            WriteEach(Root, "photo.cr3", "photo.jpg", "photo.xmp", Conflict, Workflow);
            var before = Tree();
            await TrashAsync("photo.cr3", companion: "photo.jpg");

            var outcome = await RestoreAsync("photo.jpg");

            Assert.Equal(InRoot("photo.jpg"), outcome.PrimaryPath);
            Assert.Equal(InRoot("photo.cr3"), outcome.CompanionPath);
            AssertTree(before, Tree());
            Assert.Empty(Directory.EnumerateFiles(TrashDir, "*", SearchOption.AllDirectories));
        }

        [Fact]
        public async Task AStackRestoredOverATakenName_MovesTheCopiesWithBothHalves()
        {
            WriteEach(Root, "photo.cr3", "photo.jpg", "photo.xmp", Conflict);
            await TrashAsync("photo.cr3", companion: "photo.jpg");
            File.WriteAllText(InRoot("photo.cr3"), "occupant");

            await RestoreAsync("photo.cr3");

            AssertTree(
                new Dictionary<string, string>
                {
                    ["photo.cr3"] = "occupant",
                    ["photo.restored.cr3"] = BytesOf("photo.cr3"),
                    ["photo.restored.jpg"] = BytesOf("photo.jpg"),
                    ["photo.restored.xmp"] = BytesOf("photo.xmp"),
                    ["photo.restored (conflict from Mac).xmp"] = BytesOf(Conflict),
                },
                Tree());
        }

        [Fact]
        public async Task OneHalfTrashedAlone_LeavesTheCopiesWithTheRemainingHalfAndComesBackJoiningThem()
        {
            WriteEach(Root, "photo.cr3", "photo.jpg", "photo.xmp", Conflict, Workflow);
            var before = Tree();

            await TrashAsync("photo.cr3");

            AssertTree(
                Merge(
                    Files("", "photo.jpg", "photo.xmp", Conflict, Workflow),
                    Files(".maple/trash/", "photo.cr3", "photo.xmp", Conflict, Workflow)),
                Tree());
            var outcome = await RestoreAsync("photo.cr3");
            Assert.Equal(InRoot("photo.cr3"), outcome.PrimaryPath);
            AssertTree(before, Tree());
        }

        [Fact]
        public async Task TheTwoHalvesTrashedOneAfterTheOther_SitInTheTrashOnceAndComeBackTogether()
        {
            WriteEach(Root, "photo.cr3", "photo.jpg", "photo.xmp", Conflict, Workflow);
            var before = Tree();
            await TrashAsync("photo.cr3");
            await TrashAsync("photo.jpg");
            AssertTree(Files(".maple/trash/", "photo.cr3", "photo.jpg", "photo.xmp", Conflict, Workflow), Tree());

            var outcome = await RestoreAsync("photo.cr3");

            Assert.Equal(InRoot("photo.jpg"), outcome.CompanionPath);
            AssertTree(before, Tree());
        }

        [Fact]
        public async Task TwoSameStemPhotos_TakeTheCopiesBackOnlyWhenTheLastOneLeavesTheTrash()
        {
            WriteEach(Root, "photo.dng", "photo.tif", "photo.xmp", Conflict, Workflow);
            var before = Tree();
            await TrashAsync("photo.dng");
            await TrashAsync("photo.tif");

            await RestoreAsync("photo.dng");

            AssertTree(
                Merge(
                    Files("", "photo.dng", "photo.xmp", Conflict, Workflow),
                    Files(".maple/trash/", "photo.tif", "photo.xmp", Conflict, Workflow)),
                Tree());
            var second = await RestoreAsync("photo.tif");
            Assert.Equal(InRoot("photo.tif"), second.PrimaryPath);
            AssertTree(before, Tree());
        }

        [Fact]
        public async Task ADestinationCopyIdenticalToTheTrashedOne_DoesNotTakeTheName()
        {
            WriteEach(Root, "photo.dng", Conflict);
            await TrashAsync("photo.dng");
            WriteEach(Root, Conflict);

            var outcome = await RestoreAsync("photo.dng");

            Assert.Equal(InRoot("photo.dng"), outcome.PrimaryPath);
            AssertTree(Files("", "photo.dng", Conflict), Tree());
        }

        [Fact]
        public async Task ADestinationCopyThatDiffersFromTheTrashedOne_TakesTheNameAndIsLeftUntouched()
        {
            WriteEach(Root, "photo.dng", Conflict);
            await TrashAsync("photo.dng");
            File.WriteAllText(InRoot(Conflict), "edited since");

            var outcome = await RestoreAsync("photo.dng");

            Assert.Equal(InRoot("photo.restored.dng"), outcome.PrimaryPath);
            AssertTree(
                new Dictionary<string, string>
                {
                    [Conflict] = "edited since",
                    ["photo.restored.dng"] = BytesOf("photo.dng"),
                    ["photo.restored (conflict from Mac).xmp"] = BytesOf(Conflict),
                },
                Tree());
        }

        [Fact]
        public async Task AnItemTrashedBeforeCopiesTravelled_RestoresBesideItsLeftBehindCopiesUntouched()
        {
            PlaceInTrash("photo.dng", "photo.dng", "photo.xmp");
            WriteEach(Root, Conflict, Workflow);

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(InTrash("photo.dng"), Root);

            Assert.Equal(InRoot("photo.restored.dng"), outcome.PrimaryPath);
            AssertTree(
                new Dictionary<string, string>
                {
                    [Conflict] = BytesOf(Conflict),
                    [Workflow] = BytesOf(Workflow),
                    ["photo.restored.dng"] = BytesOf("photo.dng"),
                    ["photo.restored.xmp"] = BytesOf("photo.xmp"),
                },
                Tree());
        }

        [Fact]
        public async Task ACopyOfAnotherStem_IsNeverBroughtBack()
        {
            PlaceInTrash("photo.dng", "photo.dng", "photo.1 (conflict from Mac).xmp", "photo.v2.xmp", "photo (2).xmp");
            var before = Tree();

            await LocalFileOperations.RestoreFromMapleTrashAsync(InTrash("photo.dng"), Root);

            AssertTree(
                Merge(
                    before.Where(pair => pair.Key != ".maple/trash/photo.dng"),
                    new[] { KeyValuePair.Create("photo.dng", BytesOf("photo.dng")) }),
                Tree());
        }
    }
}
