// TrashPairedEditCopiesTests — a photo moved to `.maple/trash` takes its
// conflict and workflow edit copies with it, and nothing else (#6133). Real
// files in a temp library; assertions compare the whole tree by name and
// bytes. The server (`fs/trash.ts` through `relocateFile`) carries every paired
// sidecar of the photo and, like the canonical `<stem>.xmp`, copies rather than
// takes them while a same-stem photo still reads the stem.

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
    public class TrashPairedEditCopiesTests : PairedEditCopiesFixture
    {
        private static readonly string[] Foreign =
        {
            "photo.v1234.xmp",
            "photo.v12345678-1234-1234-1234-123456789ABF.xmp",
            "photo (2).xmp",
            "photo.v2.xmp",
            "other.xmp",
            "notes.txt",
        };

        private static readonly string[] Owned = { "photo.xmp", Conflict, NumberedConflict, Workflow };

        [Fact]
        public async Task Trash_CarriesConflictAndWorkflowCopiesAndNothingElse()
        {
            WriteEach(Root, new[] { "photo.dng" }.Concat(Owned).Concat(Foreign).ToArray());

            await TrashAsync("photo.dng");

            AssertTree(
                Files("", Foreign)
                    .Concat(Files(".maple/trash/", new[] { "photo.dng" }.Concat(Owned).ToArray()))
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        [Fact]
        public async Task Trash_RecordsTheOriginalNameAndLeavesTheFolderForeignFilesUntouched()
        {
            WriteEach(Root, "photo.dng", Conflict);

            await TrashAsync("photo.dng");

            Assert.Equal("photo.dng", File.ReadAllText(InTrash("photo.dng.origpath")));
            Assert.Empty(Directory.EnumerateFiles(Root));
        }

        [Fact]
        public async Task TrashSideNameCollision_KeepsTheCopiesPairedToTheSuffixedPhoto()
        {
            WriteEach(Root, "photo.dng", "photo.xmp", "photo (conflict from Win).xmp");
            await TrashAsync("photo.dng");
            WriteEach(Root, "photo.dng", Conflict, Workflow);
            File.WriteAllText(InRoot("photo.dng"), "second photo");

            await TrashAsync("photo.dng");

            AssertTree(
                new Dictionary<string, string>
                {
                    [".maple/trash/photo.dng"] = BytesOf("photo.dng"),
                    [".maple/trash/photo.xmp"] = BytesOf("photo.xmp"),
                    [".maple/trash/photo (conflict from Win).xmp"] = BytesOf("photo (conflict from Win).xmp"),
                    [".maple/trash/photo.1.dng"] = "second photo",
                    [".maple/trash/photo.1 (conflict from Mac).xmp"] = BytesOf(Conflict),
                    [".maple/trash/photo.1.v12345678-1234-1234-1234-123456789abc.xmp"] = BytesOf(Workflow),
                },
                Tree());
            var restored = await RestoreAsync("photo.1.dng");
            Assert.Equal(InRoot("photo.dng"), restored.PrimaryPath);
            AssertTree(
                new Dictionary<string, string>
                {
                    [".maple/trash/photo.dng"] = BytesOf("photo.dng"),
                    [".maple/trash/photo.xmp"] = BytesOf("photo.xmp"),
                    [".maple/trash/photo (conflict from Win).xmp"] = BytesOf("photo (conflict from Win).xmp"),
                    ["photo.dng"] = "second photo",
                    [Conflict] = BytesOf(Conflict),
                    [Workflow] = BytesOf(Workflow),
                },
                Tree());
        }

        [Fact]
        public async Task AnUnrelatedEditFileAlreadyInTheTrash_HoldsTheNameSoThePhotoIsStoredUnderANewOne()
        {
            WriteEach(TrashDir, "photo (conflict from Other).xmp");
            WriteEach(Root, "photo.dng", Conflict);

            await TrashAsync("photo.dng");

            AssertTree(
                new Dictionary<string, string>
                {
                    [".maple/trash/photo (conflict from Other).xmp"] = BytesOf("photo (conflict from Other).xmp"),
                    [".maple/trash/photo.1.dng"] = BytesOf("photo.dng"),
                    [".maple/trash/photo.1 (conflict from Mac).xmp"] = BytesOf(Conflict),
                },
                Tree());
        }

        [Fact]
        public async Task CopiesOfAPhotoWithAFolderMateStayCopiedNotTaken()
        {
            WriteEach(Root, "photo.dng", "photo.tif", "photo.xmp", Conflict, Workflow);

            await TrashAsync("photo.dng");

            AssertTree(
                Files("", "photo.tif", "photo.xmp", Conflict, Workflow)
                    .Concat(Files(".maple/trash/", "photo.dng", "photo.xmp", Conflict, Workflow))
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        [Fact]
        public async Task TheLastSameStemPhotoToLeaveTakesTheCopiesAndJoinsTheIdenticalOnesInTheTrash()
        {
            WriteEach(Root, "photo.dng", "photo.tif", "photo.xmp", Conflict, Workflow);
            await TrashAsync("photo.dng");

            await TrashAsync("photo.tif");

            AssertTree(
                Files(".maple/trash/", "photo.dng", "photo.tif", "photo.xmp", Conflict, Workflow),
                Tree());
        }

        [Fact]
        public async Task AStackTrashedWithBothHalves_CarriesTheSharedCopiesOnce()
        {
            WriteEach(Root, "photo.cr3", "photo.jpg", "photo.xmp", Conflict, NumberedConflict, Workflow, "photo (2).xmp");

            await TrashAsync("photo.cr3", companion: "photo.jpg");

            AssertTree(
                Files("", "photo (2).xmp")
                    .Concat(Files(".maple/trash/", "photo.cr3", "photo.jpg", "photo.xmp", Conflict, NumberedConflict, Workflow))
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        [Fact]
        public async Task AStackTrashedIntoATrashHoldingTheSameNames_IsStoredUnderOneFreeNameWithItsCopies()
        {
            WriteEach(TrashDir, "photo.cr3");
            WriteEach(Root, "photo.cr3", "photo.jpg", Conflict);
            File.WriteAllText(InRoot("photo.cr3"), "second raw");

            await TrashAsync("photo.cr3", companion: "photo.jpg");

            AssertTree(
                new Dictionary<string, string>
                {
                    [".maple/trash/photo.cr3"] = BytesOf("photo.cr3"),
                    [".maple/trash/photo.1.cr3"] = "second raw",
                    [".maple/trash/photo.1.jpg"] = BytesOf("photo.jpg"),
                    [".maple/trash/photo.1 (conflict from Mac).xmp"] = BytesOf(Conflict),
                },
                Tree());
        }

        [Fact]
        public async Task AFileThatIsNotAMediaFile_LeavesItsLookAlikeEditFilesWhereTheyAre()
        {
            WriteEach(Root, "notes.txt", "notes (conflict from Mac).xmp");

            await TrashAsync("notes.txt");

            Assert.Equal(BytesOf("notes (conflict from Mac).xmp"), File.ReadAllText(InRoot("notes (conflict from Mac).xmp")));
            Assert.False(File.Exists(InTrash("notes (conflict from Mac).xmp")));
        }

        [Fact]
        public async Task AVideo_CarriesTheCopiesNamedAfterItsFullFileName()
        {
            WriteEach(Root, "clip.mov", "clip.mov.xmp", "clip.mov (conflict from Mac).xmp", "clip.xmp");

            await TrashAsync("clip.mov");

            AssertTree(
                Files("", "clip.xmp")
                    .Concat(Files(".maple/trash/", "clip.mov", "clip.mov.xmp", "clip.mov (conflict from Mac).xmp"))
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        // Windows volumes fold case, so the lower-case copy of an upper-case
        // photo is its copy; a case-sensitive folder would keep it apart.
        [Fact]
        public async Task ACopyWhoseStemDiffersOnlyInCase_TravelsUnderThePhotosSpelling()
        {
            WriteEach(Root, "PHOTO.DNG", "photo (conflict from Mac).xmp");

            await TrashAsync("PHOTO.DNG");

            AssertTree(
                Files(".maple/trash/", "PHOTO.DNG")
                    .Concat(new[] { KeyValuePair.Create(".maple/trash/PHOTO (conflict from Mac).xmp", BytesOf("photo (conflict from Mac).xmp")) })
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        // A name this long copies, but its temporary name cannot be created
        // beside it: the failing copy is real on every platform.
        private static string TooLongToStage => "photo (conflict from Z" + new string('z', 215) + ").xmp";

        [Fact]
        public async Task ACopyThatFailsMidMove_RollsEverythingBackAndLeavesTheFolderByteIdentical()
        {
            WriteEach(Root, "photo.dng", "photo.xmp", Conflict, TooLongToStage, Workflow);
            var before = Tree(withMarkers: true);

            var result = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(InRoot("photo.dng"), InRoot("photo.dng"), "photo.dng") },
                _ => Root, new FakeRecycleBinService { Succeeds = false });

            Assert.Equal(TrashOutcomeKind.Error, Assert.Single(result).Kind);
            AssertTree(before, Tree(withMarkers: true));
            Assert.Empty(Directory.EnumerateFiles(TrashDir, "*", SearchOption.AllDirectories));
        }

        [Fact]
        public async Task AStackWhoseCopyFailsMidMove_LeavesBothHalvesAndEveryEditFileWhereTheyWere()
        {
            WriteEach(Root, "photo.cr3", "photo.jpg", "photo.xmp", Conflict, TooLongToStage);
            var before = Tree(withMarkers: true);

            var result = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(InRoot("photo.cr3"), InRoot("photo.cr3"), "photo.cr3", InRoot("photo.jpg")) },
                _ => Root, new FakeRecycleBinService { Succeeds = false });

            Assert.Equal(TrashOutcomeKind.Error, Assert.Single(result).Kind);
            AssertTree(before, Tree(withMarkers: true));
        }
    }
}
