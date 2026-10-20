// SameFileTests — real temp directories, real files. Covers the two safety
// classifications the relocate primitive must get right on NTFS
// (case-insensitive-but-case-preserving, like APFS): a destination that IS
// the source must be refused before any delete runs, and a destination that
// differs ONLY in case is a legitimate rename, not a same-file refusal
// (issue #2632).

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class SameFileTests : IDisposable
    {
        private readonly string _dir;

        public SameFileTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-samefile-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        [Fact]
        public void ClassifySameFile_IdenticalPath_IsIdentical()
        {
            var path = Path.Combine(_dir, "IMG_1.CR3");
            File.WriteAllText(path, "bytes");

            var result = LocalFileOperations.ClassifySameFile(path, path);

            Assert.Equal(SameFileClassification.Identical, result);
        }

        [Fact]
        public void ClassifySameFile_CaseOnlyDifference_IsCaseOnlyRename()
        {
            var path = Path.Combine(_dir, "img.cr3");
            File.WriteAllText(path, "bytes");
            var target = Path.Combine(_dir, "IMG.CR3");

            var result = LocalFileOperations.ClassifySameFile(path, target);

            Assert.Equal(SameFileClassification.CaseOnlyRename, result);
        }

        [Fact]
        public void ClassifySameFile_DifferentName_IsDifferent()
        {
            var a = Path.Combine(_dir, "a.cr3");
            var b = Path.Combine(_dir, "b.cr3");

            Assert.Equal(SameFileClassification.Different, LocalFileOperations.ClassifySameFile(a, b));
        }

        [Fact]
        public async Task Relocate_DestinationResolvesToSource_ThrowsSameFileBeforeAnyDelete()
        {
            var path = Path.Combine(_dir, "img.cr3");
            File.WriteAllText(path, "only copy");

            var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateAsync(
                    path, _dir, "img.cr3", RelocateMode.Move, CollisionPolicy.Replace));

            Assert.Equal(FileOperationErrorKind.SameFile, ex.Kind);
            // The load-bearing guarantee: refusing BEFORE any remove/copy
            // runs means the only copy of the file must still be there.
            Assert.True(File.Exists(path));
            Assert.Equal("only copy", File.ReadAllText(path));
        }

        [Fact]
        public async Task Relocate_CaseOnlyRename_MoveMode_PerformsAtomicRenameWithSidecar()
        {
            var oldPath = Path.Combine(_dir, "img.cr3");
            var oldSidecar = Path.Combine(_dir, "img.xmp");
            File.WriteAllText(oldPath, "raw bytes");
            File.WriteAllText(oldSidecar, "<xmp/>");

            var outcome = await LocalFileOperations.RelocateAsync(
                oldPath, _dir, "IMG.CR3", RelocateMode.Move, CollisionPolicy.AutoSuffix);

            Assert.Equal(Path.Combine(_dir, "IMG.CR3"), outcome.PrimaryPath);
            Assert.Equal(Path.Combine(_dir, "IMG.xmp"), outcome.SidecarPath);
            Assert.Equal("raw bytes", File.ReadAllText(outcome.PrimaryPath));
            Assert.Equal("<xmp/>", File.ReadAllText(outcome.SidecarPath!));
            Assert.False(outcome.RenamedDueToCollision); // never routed through collision handling
        }

        [Fact]
        public async Task Relocate_CaseOnlyRename_CopyMode_ThrowsSameFile()
        {
            var path = Path.Combine(_dir, "img.cr3");
            File.WriteAllText(path, "raw bytes");

            var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateAsync(
                    path, _dir, "IMG.CR3", RelocateMode.Copy, CollisionPolicy.AutoSuffix));

            Assert.Equal(FileOperationErrorKind.SameFile, ex.Kind);
            Assert.True(File.Exists(path));
        }

        [Fact]
        public async Task Relocate_ReplaceThroughLinkedAncestor_ThrowsSameFileAndKeepsFile()
        {
            var realRoot = Path.Combine(_dir, "root");
            var realSub = Path.Combine(realRoot, "sub");
            Directory.CreateDirectory(realSub);
            var alias = Path.Combine(_dir, "alias");
            Directory.CreateSymbolicLink(alias, realRoot);
            var path = Path.Combine(realSub, "img.cr3");
            File.WriteAllText(path, "only copy");

            Assert.Equal(
                SameFileClassification.Identical,
                LocalFileOperations.ClassifySameFile(path, Path.Combine(alias, "sub", "img.cr3")));

            var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateAsync(
                    path, Path.Combine(alias, "sub"), "img.cr3", RelocateMode.Move, CollisionPolicy.Replace));

            Assert.Equal(FileOperationErrorKind.SameFile, ex.Kind);
            Assert.Equal("only copy", File.ReadAllText(path));
        }

        [Fact]
        public void ClassifySameFile_LinkedAncestorWithCaseOnlyName_IsCaseOnlyRename()
        {
            var realRoot = Path.Combine(_dir, "root");
            Directory.CreateDirectory(Path.Combine(realRoot, "sub"));
            var alias = Path.Combine(_dir, "alias");
            Directory.CreateSymbolicLink(alias, realRoot);

            Assert.Equal(
                SameFileClassification.CaseOnlyRename,
                LocalFileOperations.ClassifySameFile(
                    Path.Combine(realRoot, "sub", "img.cr3"), Path.Combine(alias, "sub", "IMG.CR3")));
        }

        [Fact]
        public void ClassifySameFile_SiblingUnderOtherLinkTarget_IsDifferent()
        {
            var a = Path.Combine(_dir, "a");
            var b = Path.Combine(_dir, "b");
            Directory.CreateDirectory(Path.Combine(a, "sub"));
            Directory.CreateDirectory(Path.Combine(b, "sub"));
            var alias = Path.Combine(_dir, "alias");
            Directory.CreateSymbolicLink(alias, b);

            Assert.Equal(
                SameFileClassification.Different,
                LocalFileOperations.ClassifySameFile(
                    Path.Combine(a, "sub", "img.cr3"), Path.Combine(alias, "sub", "img.cr3")));
        }
    }
}
