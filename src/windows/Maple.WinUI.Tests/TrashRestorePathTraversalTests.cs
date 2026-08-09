// TrashRestorePathTraversalTests — Jules review finding on #2743: the
// `.origpath` marker's recorded relative path (LocalFileOperations.
// TrashRestore.cs) is data read off disk, and on the `.maple/trash`
// fallback that file sits on a share Maple doesn't otherwise control the
// contents of. `Path.Combine` passes an absolute second argument through
// unchanged and `Path.GetFullPath` resolves `..` segments — together, a
// crafted marker containing an absolute path or a `..\..\` escape would
// silently turn a restore into an arbitrary-path file WRITE outside the
// library root. `ResolveRestoreTargetPath` refuses any recorded path that
// doesn't resolve inside the library root; these tests exercise that guard
// end to end through the real `RestoreFromMapleTrashAsync` entry point, in
// the same real-tempdir style as the rest of this suite — no mocking the
// filesystem.

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class TrashRestorePathTraversalTests : IDisposable
    {
        private readonly string _dir;

        public TrashRestorePathTraversalTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-trash-traversal-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string WriteFile(string relPath, string content)
        {
            var full = Path.Combine(_dir, relPath);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        /// <summary>Writes a `.origpath` marker directly — bypassing
        /// <see cref="LocalFileOperations.TryWriteOriginalPathMarker"/> —
        /// to model an attacker- or corruption-crafted marker rather than
        /// one this module wrote itself.</summary>
        private static string WriteMarker(string trashPrimaryPath, string content)
        {
            var markerPath = LocalFileOperations.OriginalPathMarkerFor(trashPrimaryPath);
            File.WriteAllText(markerPath, content);
            return markerPath;
        }

        [Fact]
        public async Task RestoreFromMapleTrashAsync_OrigpathIsWindowsAbsolutePath_ThrowsAndLeavesTrashedFileInPlace()
        {
            var libraryRoot = _dir;
            var trashedPath = WriteFile(Path.Combine(".maple", "trash", "Album", "photo.dng"), "bytes");
            WriteMarker(trashedPath, @"C:\Windows\System32\evil.dng");

            var ex = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.RestoreFromMapleTrashAsync(trashedPath, libraryRoot));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
            Assert.True(File.Exists(trashedPath));
        }

        [Fact]
        public async Task RestoreFromMapleTrashAsync_OrigpathIsRootedPathOutsideLibrary_ThrowsAndLeavesTrashedFileInPlace()
        {
            var libraryRoot = _dir;
            var trashedPath = WriteFile(Path.Combine(".maple", "trash", "Album", "photo.dng"), "bytes");
            // A rooted path built from the real temp dir (not just a bare
            // "C:\..." literal) so this is meaningful regardless of which
            // drive the CI runner's temp dir lives on.
            var outsideDir = Path.Combine(Path.GetTempPath(), "maple-winui-trash-traversal-outside-" + Guid.NewGuid().ToString("N"));
            var outsideTarget = Path.Combine(outsideDir, "evil.dng");
            WriteMarker(trashedPath, outsideTarget);

            var ex = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.RestoreFromMapleTrashAsync(trashedPath, libraryRoot));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
            Assert.True(File.Exists(trashedPath));
            Assert.False(File.Exists(outsideTarget));
        }

        [Fact]
        public async Task RestoreFromMapleTrashAsync_OrigpathIsParentTraversal_ThrowsAndLeavesTrashedFileInPlace()
        {
            var libraryRoot = _dir;
            var trashedPath = WriteFile(Path.Combine(".maple", "trash", "Album", "photo.dng"), "bytes");
            WriteMarker(trashedPath, Path.Combine("..", "..", "escape.dng"));
            var escapedPath = Path.GetFullPath(Path.Combine(libraryRoot, "..", "..", "escape.dng"));

            var ex = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.RestoreFromMapleTrashAsync(trashedPath, libraryRoot));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, ex.Kind);
            Assert.True(File.Exists(trashedPath));
            Assert.False(File.Exists(escapedPath));
        }

        [Fact]
        public async Task RestoreFromMapleTrashAsync_OrigpathIsOrdinaryNestedRelativePath_RestoresNormally()
        {
            // Control case: a well-formed marker (what this module actually
            // writes at trash time) must still restore fine — the guard
            // must reject only what's actually outside the root, not
            // ordinary nested relative paths.
            var libraryRoot = _dir;
            var trashedPath = WriteFile(Path.Combine(".maple", "trash", "Album", "Sub", "photo.dng"), "bytes");
            WriteMarker(trashedPath, Path.Combine("Album", "Sub", "photo.dng"));

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(trashedPath, libraryRoot);

            Assert.Equal(Path.Combine(libraryRoot, "Album", "Sub", "photo.dng"), outcome.PrimaryPath);
            Assert.True(File.Exists(outcome.PrimaryPath));
        }
    }
}
