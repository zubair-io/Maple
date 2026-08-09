// DropMountLogicTests — real temp directories, real files. Covers the four
// drop-to-mount cases from #2651: single file -> Full Image, folder ->
// Browse, multiple loose files -> Browse with selection, already-mounted ->
// navigate only, plus the unsupported-type and missing-on-disk cases.

using System;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class DropMountLogicTests : IDisposable
    {
        private readonly string _dir;

        public DropMountLogicTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-drop-mount-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string MakeFile(string relativePath)
        {
            var full = Path.Combine(_dir, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, "bytes");
            return full;
        }

        private string MakeFolder(string relativePath)
        {
            var full = Path.Combine(_dir, relativePath);
            Directory.CreateDirectory(full);
            return full;
        }

        // --- Case 1: single file -> mount parent, open Full Image ---

        [Fact]
        public void Classify_SingleSupportedFile_OpensFullImageAndMountsParent()
        {
            var photosDir = MakeFolder("Trip");
            var file = MakeFile(Path.Combine("Trip", "IMG_0001.dng"));

            var plan = DropMountLogic.Classify(new[] { file }, Array.Empty<string>());

            Assert.Equal(DropOutcomeKind.OpenFile, plan.Kind);
            Assert.False(plan.AlreadyMounted);
            Assert.Equal(photosDir, plan.MountRoot);
            Assert.Equal(photosDir, plan.NavigateFolder);
            Assert.Equal(new[] { file }, plan.SelectFiles);
            Assert.Null(plan.UnsupportedReason);
        }

        // --- Case 2: folder -> mount + Browse ---

        [Fact]
        public void Classify_SingleFolder_OpensBrowseAndMountsFolderItself()
        {
            var folder = MakeFolder("Wedding");
            MakeFile(Path.Combine("Wedding", "IMG_0002.jpg"));

            var plan = DropMountLogic.Classify(new[] { folder }, Array.Empty<string>());

            Assert.Equal(DropOutcomeKind.Browse, plan.Kind);
            Assert.False(plan.AlreadyMounted);
            Assert.Equal(folder, plan.MountRoot);
            Assert.Equal(folder, plan.NavigateFolder);
            Assert.Empty(plan.SelectFiles);
        }

        // --- Case 3: multiple loose files -> mount common parent, Browse + select ---

        [Fact]
        public void Classify_MultipleLooseFilesSameFolder_MountsParentAndSelectsAll()
        {
            var folder = MakeFolder("Shoot");
            var fileA = MakeFile(Path.Combine("Shoot", "a.cr2"));
            var fileB = MakeFile(Path.Combine("Shoot", "b.cr2"));

            var plan = DropMountLogic.Classify(new[] { fileA, fileB }, Array.Empty<string>());

            Assert.Equal(DropOutcomeKind.Browse, plan.Kind);
            Assert.False(plan.AlreadyMounted);
            Assert.Equal(folder, plan.MountRoot);
            Assert.Equal(folder, plan.NavigateFolder);
            Assert.Equal(new[] { fileA, fileB }, plan.SelectFiles.OrderBy(f => f));
        }

        [Fact]
        public void Classify_MultipleLooseFilesDifferentFolders_MountsCommonAncestor()
        {
            var common = MakeFolder("Library");
            var fileA = MakeFile(Path.Combine("Library", "2026", "a.nef"));
            var fileB = MakeFile(Path.Combine("Library", "2027", "b.nef"));

            var plan = DropMountLogic.Classify(new[] { fileA, fileB }, Array.Empty<string>());

            Assert.Equal(DropOutcomeKind.Browse, plan.Kind);
            Assert.Equal(common, plan.MountRoot);
            Assert.Equal(common, plan.NavigateFolder);
        }

        // --- Case 4: already inside a mounted source -> navigate only, no remount ---

        [Fact]
        public void Classify_SingleFileAlreadyUnderLibraryRoot_NoMountJustOpensFullImage()
        {
            var root = MakeFolder("Library");
            var file = MakeFile(Path.Combine("Library", "2026", "IMG_0003.dng"));

            var plan = DropMountLogic.Classify(new[] { file }, new[] { root });

            Assert.Equal(DropOutcomeKind.OpenFile, plan.Kind);
            Assert.True(plan.AlreadyMounted);
            Assert.Null(plan.MountRoot);
            Assert.Equal(new[] { file }, plan.SelectFiles);
        }

        [Fact]
        public void Classify_FolderAlreadyRegisteredAsRoot_NoRemountJustBrowses()
        {
            var root = MakeFolder("Library");

            var plan = DropMountLogic.Classify(new[] { root }, new[] { root });

            Assert.Equal(DropOutcomeKind.Browse, plan.Kind);
            Assert.True(plan.AlreadyMounted);
            Assert.Null(plan.MountRoot);
            Assert.Equal(root, plan.NavigateFolder);
        }

        [Fact]
        public void Classify_FilesUnderDifferentExistingRoots_StillCountsAsAlreadyMounted()
        {
            var rootA = MakeFolder("RootA");
            var rootB = MakeFolder("RootB");
            var fileA = MakeFile(Path.Combine("RootA", "a.dng"));
            var fileB = MakeFile(Path.Combine("RootB", "b.dng"));

            var plan = DropMountLogic.Classify(new[] { fileA, fileB }, new[] { rootA, rootB });

            Assert.True(plan.AlreadyMounted);
            Assert.Null(plan.MountRoot);
        }

        [Fact]
        public void Classify_OneFileMountedOneNot_TreatsAsNotFullyMounted()
        {
            var root = MakeFolder("RootA");
            var fileMounted = MakeFile(Path.Combine("RootA", "a.dng"));
            var fileOutside = MakeFile("b.dng");

            var plan = DropMountLogic.Classify(new[] { fileMounted, fileOutside }, new[] { root });

            Assert.False(plan.AlreadyMounted);
            Assert.NotNull(plan.MountRoot);
        }

        // --- Unsupported type / missing on disk ---

        [Fact]
        public void Classify_UnsupportedFileType_ReturnsUnsupportedWithReason()
        {
            var file = MakeFile("notes.txt");

            var plan = DropMountLogic.Classify(new[] { file }, Array.Empty<string>());

            Assert.Equal(DropOutcomeKind.Unsupported, plan.Kind);
            Assert.False(plan.AlreadyMounted);
            Assert.Null(plan.MountRoot);
            Assert.Contains("notes.txt", plan.UnsupportedReason);
        }

        [Fact]
        public void Classify_PathNoLongerOnDisk_ReturnsUnsupported()
        {
            var goneFile = Path.Combine(_dir, "gone.dng");

            var plan = DropMountLogic.Classify(new[] { goneFile }, Array.Empty<string>());

            Assert.Equal(DropOutcomeKind.Unsupported, plan.Kind);
            Assert.NotNull(plan.UnsupportedReason);
        }

        [Fact]
        public void Classify_EmptyDrop_ReturnsUnsupported()
        {
            var plan = DropMountLogic.Classify(Array.Empty<string>(), Array.Empty<string>());

            Assert.Equal(DropOutcomeKind.Unsupported, plan.Kind);
            Assert.NotNull(plan.UnsupportedReason);
        }

        [Fact]
        public void Classify_MixOfSupportedAndUnsupported_ProceedsWithSupportedOnly()
        {
            var folder = MakeFolder("Mixed");
            var goodFile = MakeFile(Path.Combine("Mixed", "good.dng"));
            MakeFile(Path.Combine("Mixed", "readme.txt"));

            var plan = DropMountLogic.Classify(
                new[] { goodFile, Path.Combine(folder, "readme.txt") }, Array.Empty<string>());

            Assert.Equal(DropOutcomeKind.OpenFile, plan.Kind);
            Assert.Equal(new[] { goodFile }, plan.SelectFiles);
        }

        // --- Case-insensitive NTFS comparisons ---

        [Fact]
        public void Classify_DroppedPathCasingDiffersFromRoot_StillDetectedAsAlreadyMounted()
        {
            var root = MakeFolder("CaseRoot");
            var file = MakeFile(Path.Combine("CaseRoot", "IMG_0004.dng"));

            var plan = DropMountLogic.Classify(new[] { file }, new[] { root.ToUpperInvariant() });

            Assert.True(plan.AlreadyMounted);
        }
    }
}
