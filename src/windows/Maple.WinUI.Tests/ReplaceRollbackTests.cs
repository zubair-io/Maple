// ReplaceRollbackTests — a Replace that fails after the incoming photo was
// published must leave the destination exactly as it was (#6135). Real temp
// directories, real files; whole-folder comparisons by name and bytes.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class ReplaceRollbackTests : IDisposable
    {
        private static readonly DateTime OldMtimeUtc = new(2020, 3, 14, 9, 26, 53, DateTimeKind.Utc);

        private readonly string _dir;

        public ReplaceRollbackTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-replace-rollback-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(P("src"));
            Directory.CreateDirectory(P("dest"));
        }

        public void Dispose()
        {
            foreach (var file in Directory.EnumerateFiles(_dir, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string P(params string[] parts) => Path.Combine(_dir, Path.Combine(parts));

        private string Write(string content, params string[] parts)
        {
            var full = P(parts);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        private SortedDictionary<string, string?> Tree(string folder) =>
            new(
                Directory.EnumerateFileSystemEntries(P(folder), "*", SearchOption.AllDirectories)
                    .ToDictionary(
                        path => Path.GetRelativePath(P(folder), path),
                        path => File.Exists(path) ? File.ReadAllText(path) : null),
                StringComparer.Ordinal);

        [Fact]
        public async Task WhenTheSidecarCannotFollow_TheReplacedPhotoIsPutBack()
        {
            Write("new photo", "src", "photo.dng");
            Write("<new/>", "src", "photo.xmp");
            var oldPhoto = Write("old photo", "dest", "photo.dng");
            File.SetLastWriteTimeUtc(oldPhoto, OldMtimeUtc);
            Write("someone's note", "dest", "photo.xmp", "note.txt");
            var (sourceBefore, destinationBefore) = (Tree("src"), Tree("dest"));

            var failure = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateAsync(
                    P("src", "photo.dng"), P("dest"), null, RelocateMode.Move, CollisionPolicy.Replace));

            Assert.Equal(FileOperationErrorKind.Underlying, failure.Kind);

            Assert.Equal(destinationBefore, Tree("dest"));
            Assert.Equal(sourceBefore, Tree("src"));
            Assert.True((File.GetLastWriteTimeUtc(oldPhoto) - OldMtimeUtc).Duration() < TimeSpan.FromSeconds(1));
        }

        [Fact]
        public async Task WhenNothingWasReplaced_TheSidecarFailureRemovesThePublishedPhoto()
        {
            Write("new photo", "src", "photo.dng");
            Write("<new/>", "src", "photo.xmp");
            Write("someone's note", "dest", "photo.xmp", "note.txt");
            var (sourceBefore, destinationBefore) = (Tree("src"), Tree("dest"));

            var failure = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateAsync(
                    P("src", "photo.dng"), P("dest"), null, RelocateMode.Move, CollisionPolicy.Replace));

            Assert.Equal(FileOperationErrorKind.Underlying, failure.Kind);

            Assert.Equal(destinationBefore, Tree("dest"));
            Assert.Equal(sourceBefore, Tree("src"));
        }

        [Fact]
        public async Task AReadOnlyReplacedPhoto_ComesBackReadOnly_AndLeavesNoBackupBehind()
        {
            Write("new photo", "src", "photo.dng");
            Write("<new/>", "src", "photo.xmp");
            var oldPhoto = Write("old photo", "dest", "photo.dng");
            File.SetAttributes(oldPhoto, FileAttributes.ReadOnly);
            Write("someone's note", "dest", "photo.xmp", "note.txt");
            var (sourceBefore, destinationBefore) = (Tree("src"), Tree("dest"));

            var failure = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateAsync(
                    P("src", "photo.dng"), P("dest"), null, RelocateMode.Move, CollisionPolicy.Replace));

            Assert.Equal(FileOperationErrorKind.Underlying, failure.Kind);
            Assert.Equal(destinationBefore, Tree("dest"));
            Assert.Equal(sourceBefore, Tree("src"));
            Assert.DoesNotContain(Tree("dest").Keys, name => name.Contains(".tmp."));
            Assert.True(File.GetAttributes(oldPhoto).HasFlag(FileAttributes.ReadOnly));
        }

        [Fact]
        public async Task AReadOnlyIncomingPhoto_StillLetsTheReplacedPhotoComeBack()
        {
            File.SetAttributes(Write("new photo", "src", "photo.dng"), FileAttributes.ReadOnly);
            Write("<new/>", "src", "photo.xmp");
            var oldPhoto = Write("old photo", "dest", "photo.dng");
            Write("someone's note", "dest", "photo.xmp", "note.txt");
            var (sourceBefore, destinationBefore) = (Tree("src"), Tree("dest"));

            var failure = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.RelocateAsync(
                    P("src", "photo.dng"), P("dest"), null, RelocateMode.Move, CollisionPolicy.Replace));

            Assert.Equal(FileOperationErrorKind.Underlying, failure.Kind);
            Assert.Equal(destinationBefore, Tree("dest"));
            Assert.Equal(sourceBefore, Tree("src"));
            Assert.DoesNotContain(Tree("dest").Keys, name => name.Contains(".tmp."));
            Assert.False(File.GetAttributes(oldPhoto).HasFlag(FileAttributes.ReadOnly));
        }

        [Fact]
        public async Task ASuccessfulReplace_LeavesNoBackupBehind()
        {
            Write("new photo", "src", "photo.dng");
            Write("<new/>", "src", "photo.xmp");
            Write("old photo", "dest", "photo.dng");
            Write("<old/>", "dest", "photo.xmp");

            await LocalFileOperations.RelocateAsync(
                P("src", "photo.dng"), P("dest"), null, RelocateMode.Move, CollisionPolicy.Replace);

            Assert.Equal(
                new SortedDictionary<string, string?>(StringComparer.Ordinal)
                {
                    ["photo.dng"] = "new photo",
                    ["photo.xmp"] = "<new/>",
                },
                Tree("dest"));
            Assert.Empty(Tree("src"));
        }
    }
}
