// PairedCopyOwnershipTests — which edit files are a photo's own (#6133): the
// pure pairing decision with the folder's case behaviour injected, and the
// products' trash and relocate against real files.

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
    public class PairedCopyOwnershipTests : PairedEditCopiesFixture
    {
        private const string Uuid = "12345678-1234-1234-1234-123456789abc";

        [Fact]
        public void PairedCopyNames_LeavesAnotherPhotosOwnSidecarWithThatPhoto()
        {
            var names = new[]
            {
                "photo.dng", "photo.xmp", "photo (conflict from Mac).dng", "photo (conflict from Mac).xmp",
                "photo (conflict from Win).xmp", $"photo.v{Uuid}.dng", $"photo.v{Uuid}.xmp",
                "photo.v12345678-1234-1234-1234-123456789def.xmp",
                "photo (conflict from Mac).txt", "photo (conflict from Mac)",
            };

            Assert.Equal(
                new[] { "photo (conflict from Win).xmp", "photo.v12345678-1234-1234-1234-123456789def.xmp" },
                LocalFileOperations.PairedCopyNames(names, "photo.dng", foldsCase: true));
        }

        [Fact]
        public void PairedCopyNames_CoversTheVideoFullNameForm()
        {
            var names = new[]
            {
                "clip.mov", "clip.mov.xmp", "clip.mov (conflict from Mac).dng", "clip.mov (conflict from Mac).xmp",
                "clip.mov (conflict from Win).xmp", $"clip.mov.v{Uuid}.dng", $"clip.mov.v{Uuid}.xmp",
                "clip.mov (conflict from Mac)", "clip.mov (conflict from Mac).txt",
            };

            Assert.Equal(
                new[] { "clip.mov (conflict from Win).xmp" },
                LocalFileOperations.PairedCopyNames(names, "clip.mov", foldsCase: true));
        }

        [Fact]
        public void PairedCopyNames_AVideoWithAnImageStemIsNotTheOwnerOfAnImagesCopy()
        {
            var names = new[] { "photo.dng", "photo (conflict from Mac).mov", "photo (conflict from Mac).xmp" };

            Assert.Equal(
                new[] { "photo (conflict from Mac).xmp" },
                LocalFileOperations.PairedCopyNames(names, "photo.dng", foldsCase: true));
        }

        [Fact]
        public void PairedCopyNames_InAFolderThatKeepsCaseApart_KeepsTwoCopiesDifferingOnlyInCase()
        {
            var names = new[]
            {
                "photo.dng", "photo (conflict from MAC).xmp", "photo (conflict from mac).xmp", "PHOTO (conflict from Mac).xmp",
            };

            var apart = LocalFileOperations.PairedCopyNames(names, "photo.dng", foldsCase: false);
            var folded = LocalFileOperations.PairedCopyNames(names, "photo.dng", foldsCase: true);

            Assert.Equal(new[] { "photo (conflict from MAC).xmp", "photo (conflict from mac).xmp" }, apart);
            Assert.Equal(3, folded.Count);
        }

        [Fact]
        public void TwoCopiesDifferingOnlyInCase_NeitherCrashTheNameChecksNorShareATarget()
        {
            var copies = new[] { InRoot("photo (conflict from MAC).xmp"), InRoot("photo (conflict from mac).xmp") };
            var scan = new PairedCopyScan(copies, Array.Empty<string>());
            var target = InRoot("photo.1.dng");

            var held = Record.Exception(() => LocalFileOperations.AdoptableNameHeldByOther(
                scan, InRoot("photo.dng"), target, new[] { "photo.1 (conflict from MAC).xmp" }, includeCanonical: false));

            Assert.Null(held);
            Assert.Equal(2, copies.Select(copy => LocalFileOperations.PairedCopyTarget(copy, InRoot("photo.dng"), target)).Distinct().Count());
        }

        [Fact]
        public async Task Trash_LeavesAnotherPhotosOwnSidecarWithThatPhoto()
        {
            WriteEach(Root, "photo.dng", "photo.xmp", "photo (conflict from Mac).dng", "photo (conflict from Mac).xmp", Conflict.Replace("Mac", "Win"));

            await TrashAsync("photo.dng");

            AssertTree(
                Files("", "photo (conflict from Mac).dng", "photo (conflict from Mac).xmp")
                    .Concat(Files(".maple/trash/", "photo.dng", "photo.xmp", "photo (conflict from Win).xmp"))
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        [Fact]
        public async Task Trash_LeavesTheSidecarOfAPhotoNamedLikeAWorkflowCopy()
        {
            var lookalike = $"photo.v{Uuid}";
            WriteEach(Root, "photo.dng", lookalike + ".dng", lookalike + ".xmp");

            await TrashAsync("photo.dng");

            AssertTree(
                Files("", lookalike + ".dng", lookalike + ".xmp").Concat(Files(".maple/trash/", "photo.dng"))
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        [Fact]
        public async Task AHiddenSameStemPhoto_HoldsTheCanonicalSidecarAndTheCopiesBack()
        {
            WriteEach(Root, ".a.dng", ".a.tif", ".a.xmp", ".a (conflict from Mac).xmp");

            await TrashAsync(".a.dng");

            AssertTree(
                Files("", ".a.tif", ".a.xmp", ".a (conflict from Mac).xmp")
                    .Concat(Files(".maple/trash/", ".a.dng", ".a.xmp", ".a (conflict from Mac).xmp"))
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        [Fact]
        public async Task AHiddenSameStemPhoto_HoldsTheSidecarBackFromAnOrdinaryMoveToo()
        {
            WriteEach(Root, ".a.dng", ".a.tif", ".a.xmp");

            await LocalFileOperations.RelocateAsync(InRoot(".a.dng"), InRoot("out"), null, RelocateMode.Move);

            AssertTree(
                Files("", ".a.tif", ".a.xmp").Concat(Files("out/", ".a.dng", ".a.xmp"))
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        [Fact]
        public async Task AResourceForkStub_NeverHoldsASidecarBack()
        {
            WriteEach(Root, "._a.dng", "._a.tif", "._a.xmp");

            await LocalFileOperations.RelocateAsync(InRoot("._a.dng"), InRoot("out"), null, RelocateMode.Move);

            AssertTree(Files("", "._a.tif").Concat(Files("out/", "._a.dng", "._a.xmp")).ToDictionary(pair => pair.Key, pair => pair.Value), Tree());
        }

        [Fact]
        public async Task OrdinaryMove_LeavesTheEditCopiesWhereTheyAre()
        {
            WriteEach(Root, "photo.dng", "photo.xmp", Conflict, Workflow);

            await LocalFileOperations.RelocateAsync(InRoot("photo.dng"), InRoot("out"), null, RelocateMode.Move);

            AssertTree(
                Files("", Conflict, Workflow).Concat(Files("out/", "photo.dng", "photo.xmp")).ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        [Fact]
        public async Task OrdinaryRename_LeavesTheEditCopiesUnderTheirOldNames()
        {
            WriteEach(Root, "photo.dng", "photo.xmp", Conflict, Workflow);

            await LocalFileOperations.RelocateAsync(InRoot("photo.dng"), Root, "renamed.dng", RelocateMode.Move, CollisionPolicy.Fail);

            AssertTree(
                new Dictionary<string, string>
                {
                    ["renamed.dng"] = BytesOf("photo.dng"),
                    ["renamed.xmp"] = BytesOf("photo.xmp"),
                    [Conflict] = BytesOf(Conflict),
                    [Workflow] = BytesOf(Workflow),
                },
                Tree());
        }

        [Fact]
        public async Task OrdinaryCopy_DoesNotCopyTheEditCopies()
        {
            WriteEach(Root, "photo.dng", "photo.xmp", Conflict, Workflow);

            await LocalFileOperations.RelocateAsync(InRoot("photo.dng"), InRoot("out"), null, RelocateMode.Copy);

            AssertTree(
                Files("", "photo.dng", "photo.xmp", Conflict, Workflow).Concat(Files("out/", "photo.dng", "photo.xmp"))
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }
        [Fact]
        public async Task Trash_IgnoresLookAlikesThatAreNotEditFiles()
        {
            WriteEach(Root, "photo.dng", Conflict, "photo (conflict from Mac).txt", "photo (conflict from Mac)");

            await TrashAsync("photo.dng");

            AssertTree(
                Files("", "photo (conflict from Mac).txt", "photo (conflict from Mac)")
                    .Concat(Files(".maple/trash/", "photo.dng", Conflict))
                    .ToDictionary(pair => pair.Key, pair => pair.Value),
                Tree());
        }

        [Fact]
        public async Task Restore_MovesOnWhenACopyWouldLandOnAPhotoThatAppearedWithoutASidecar()
        {
            WriteEach(Root, "photo.dng", Conflict);
            await TrashAsync("photo.dng");
            WriteEach(Root, "photo (conflict from Mac).dng");

            var outcome = await RestoreAsync("photo.dng");

            Assert.Equal(InRoot("photo.restored.dng"), outcome.PrimaryPath);
            AssertTree(
                new Dictionary<string, string>
                {
                    ["photo (conflict from Mac).dng"] = BytesOf("photo (conflict from Mac).dng"),
                    ["photo.restored.dng"] = BytesOf("photo.dng"),
                    ["photo.restored (conflict from Mac).xmp"] = BytesOf(Conflict),
                },
                Tree());
        }

        [Fact]
        public async Task RestoreOfAStack_MovesOnWhenACopyWouldLandOnAPhotoThatAppearedWithoutASidecar()
        {
            WriteEach(Root, "photo.cr3", "photo.jpg", Conflict);
            await TrashAsync("photo.cr3", companion: "photo.jpg");
            WriteEach(Root, "photo (conflict from Mac).dng");

            var outcome = await RestoreAsync("photo.cr3");

            Assert.Equal(InRoot("photo.restored.cr3"), outcome.PrimaryPath);
            AssertTree(
                new Dictionary<string, string>
                {
                    ["photo (conflict from Mac).dng"] = BytesOf("photo (conflict from Mac).dng"),
                    ["photo.restored.cr3"] = BytesOf("photo.cr3"),
                    ["photo.restored.jpg"] = BytesOf("photo.jpg"),
                    ["photo.restored (conflict from Mac).xmp"] = BytesOf(Conflict),
                },
                Tree());
        }

        [Fact]
        public async Task Trash_MovesOnWhenACopyWouldLandOnAPhotoAlreadyInTheTrash()
        {
            WriteEach(TrashDir, "photo (conflict from Mac).dng");
            WriteEach(Root, "photo.dng", Conflict);

            await TrashAsync("photo.dng");

            AssertTree(
                new Dictionary<string, string>
                {
                    [".maple/trash/photo (conflict from Mac).dng"] = BytesOf("photo (conflict from Mac).dng"),
                    [".maple/trash/photo.1.dng"] = BytesOf("photo.dng"),
                    [".maple/trash/photo.1 (conflict from Mac).xmp"] = BytesOf(Conflict),
                },
                Tree());
        }
    }
}
