// Restoring a trashed photo whose name starts with a dot (#6113): it puts back
// a name the file already had, so the leading dot is no reason to refuse it.
// A name a user types is still refused, and a recorded name stays a bare, safe
// file name that cannot reach `.maple`.

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RestoreHiddenNameTests : IDisposable
    {
        private readonly string _root =
            Path.Combine(Path.GetTempPath(), "maple-winui-restore-hidden-" + Guid.NewGuid().ToString("N"));

        public RestoreHiddenNameTests() => Directory.CreateDirectory(_root);

        public void Dispose()
        {
            try { Directory.Delete(_root, recursive: true); }
            catch (IOException) { }
        }

        private string TrashDir => Path.Combine(_root, ".maple", "trash");

        private async Task<string> TrashAsync(string name, string content, string? companion = null)
        {
            var path = Path.Combine(_root, name);
            File.WriteAllText(path, content);
            var companionPath = companion == null ? null : Path.Combine(_root, companion);
            if (companionPath != null) File.WriteAllText(companionPath, "jpeg");
            var results = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(path, path, name, companionPath) }, _ => _root,
                new FakeRecycleBinService { Succeeds = false });
            Assert.True(results.All(r => r.Error == null), string.Join(";", results.Select(r => r.ToString())));
            return Path.Combine(TrashDir, name);
        }

        private string[] FolderNames() =>
            Directory.EnumerateFileSystemEntries(_root).Select(p => Path.GetFileName(p)!)
                .OrderBy(n => n, StringComparer.Ordinal).ToArray();

        private string[] Snapshot() =>
            Directory.EnumerateFileSystemEntries(_root, "*", SearchOption.AllDirectories)
                .Select(p => Path.GetRelativePath(_root, p) + (File.Exists(p) ? ":" + Convert.ToHexString(File.ReadAllBytes(p)) : "/"))
                .OrderBy(n => n, StringComparer.Ordinal).ToArray();

        [Fact]
        public async Task AHiddenPhoto_ComesBackUnderItsOwnNameWithItsSidecar_WhenTheNameIsFree()
        {
            File.WriteAllText(Path.Combine(_root, ".photo.xmp"), "<edits/>");
            var trashed = await TrashAsync(".photo.dng", "raw");
            Assert.True(File.Exists(Path.Combine(TrashDir, ".photo.xmp")));

            var restored = await LocalFileOperations.RestoreFromMapleTrashAsync(trashed, _root);

            Assert.Equal(Path.Combine(_root, ".photo.dng"), restored.PrimaryPath);
            Assert.Equal("raw", File.ReadAllText(restored.PrimaryPath));
            Assert.Equal("<edits/>", File.ReadAllText(Path.Combine(_root, ".photo.xmp")));
            Assert.Equal(new[] { ".maple", ".photo.dng", ".photo.xmp" }, FolderNames());
        }

        [Fact]
        public async Task AHiddenPhoto_TakesTheRestoredForm_WhenItsNameIsTaken()
        {
            File.WriteAllText(Path.Combine(_root, ".photo.xmp"), "<edits/>");
            var trashed = await TrashAsync(".photo.dng", "raw");
            File.WriteAllText(Path.Combine(_root, ".photo.dng"), "occupant");

            var restored = await LocalFileOperations.RestoreFromMapleTrashAsync(trashed, _root);

            Assert.Equal(Path.Combine(_root, ".photo.restored.dng"), restored.PrimaryPath);
            Assert.Equal("raw", File.ReadAllText(restored.PrimaryPath));
            Assert.Equal("occupant", File.ReadAllText(Path.Combine(_root, ".photo.dng")));
            Assert.Equal("<edits/>", File.ReadAllText(Path.Combine(_root, ".photo.restored.xmp")));
        }

        [Fact]
        public async Task AHiddenExtensionlessPhoto_TakesTheRestoredForm_WhenItsNameIsTaken()
        {
            var trashed = await TrashAsync(".photo", "raw");
            File.WriteAllText(Path.Combine(_root, ".photo"), "occupant");

            var restored = await LocalFileOperations.RestoreFromMapleTrashAsync(trashed, _root);

            Assert.Equal(Path.Combine(_root, ".photo.restored"), restored.PrimaryPath);
            Assert.Equal("occupant", File.ReadAllText(Path.Combine(_root, ".photo")));
        }

        [Fact]
        public async Task AHiddenPair_ComesBackTogetherUnderItsOwnNames_AndUnderTheRestoredFormWhenTaken()
        {
            var trashed = await TrashAsync(".IMG_1.CR3", "raw", ".IMG_1.JPG");
            var free = await LocalFileOperations.RestoreFromMapleTrashAsync(trashed, _root);
            Assert.Equal(Path.Combine(_root, ".IMG_1.CR3"), free.PrimaryPath);
            Assert.Equal(Path.Combine(_root, ".IMG_1.JPG"), free.CompanionPath);

            var trashedAgain = await TrashAsync(".IMG_1.CR3", "raw", ".IMG_1.JPG");
            File.WriteAllText(Path.Combine(_root, ".IMG_1.JPG"), "occupant");
            var taken = await LocalFileOperations.RestoreFromMapleTrashAsync(trashedAgain, _root);

            Assert.Equal(Path.Combine(_root, ".IMG_1.restored.CR3"), taken.PrimaryPath);
            Assert.Equal(Path.Combine(_root, ".IMG_1.restored.JPG"), taken.CompanionPath);
            Assert.Equal("occupant", File.ReadAllText(Path.Combine(_root, ".IMG_1.JPG")));
        }

        public static TheoryData<string> RefusedRecordedPaths() => new()
        {
            ".maple",
            ".MAPLE",
            ".",
            "..",
            Path.Combine("sub", "."),
            Path.Combine("a", "b", ".."),
            Path.Combine("..", "..", "escaped.dng"),
            Path.Combine(".maple", "trash", "inside.dng"),
            Path.Combine(".maple", ".photo.dng"),
            Path.Combine("sub", ".maple", "thumbs", "x.dng"),
            ".maple:x",
            "sub\\.maple:x",
            "C:photo.dng",
            "CON.dng",
            "CON\\x.dng",
            "sub/nul/x.dng",
            ".photo.",
            "sub\\. ",
            ".maple.\\x",
            ".maple \\x",
            "sub//photo.dng",
            "/photo.dng",
            "\\photo.dng",
            "sub/",
        };

        public static TheoryData<string, bool> RecordedPathVerdicts() => new()
        {
            { "photo.dng", true },
            { "sub/photo.dng", true },
            { "sub\\photo.dng", true },
            { ".photo.dng", true },
            { ".photo", true },
            { ".hidden/photo.dng", true },
            { "sub\\.hidden\\.photo", true },
            { "a..b/photo.dng", true },
            { ".maple", false },
            { ".MAPLE", false },
            { "sub/.maple/thumbs/x.dng", false },
            { ".maple:x", false },
            { "sub\\.maple:x", false },
            { "C:photo.dng", false },
            { "CON\\x.dng", false },
            { "con.dng", false },
            { "sub/NUL", false },
            { ".photo.", false },
            { "photo.dng ", false },
            { "sub\\. ", false },
            { ".maple.\\x", false },
            { ".maple \\x", false },
            { "a/b/..", false },
            { "a/./b.dng", false },
            { "sub//photo.dng", false },
            { "/photo.dng", false },
            { "sub/", false },
            { "", false },
        };

        [Theory]
        [MemberData(nameof(RecordedPathVerdicts))]
        public void TheRecordedPathCheck_JudgesEverySegmentAsWritten(string recorded, bool restorable) =>
            Assert.Equal(restorable, LocalFileOperations.IsRestorableRelativePath(recorded));

        [Theory]
        [MemberData(nameof(RefusedRecordedPaths))]
        public async Task ARecordedPathThatIsNotASafeName_IsRefusedAndNothingMoves(string recorded)
        {
            var trashed = await TrashAsync(".photo.dng", "raw");
            File.WriteAllText(LocalFileOperations.OriginalPathMarkerFor(trashed), recorded);
            var before = Snapshot();

            var refused = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.RestoreFromMapleTrashAsync(trashed, _root));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, refused.Kind);
            Assert.Equal(before, Snapshot());
        }

        [Fact]
        public async Task ARecordedPairName_IsRefusedWhenItNamesMaple()
        {
            var trashed = await TrashAsync("IMG_1.CR3", "raw", "IMG_1.JPG");
            File.WriteAllText(LocalFileOperations.OriginalPathMarkerFor(trashed), ".maple");
            var before = Snapshot();

            var refused = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.RestoreFromMapleTrashAsync(trashed, _root));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, refused.Kind);
            Assert.Equal(before, Snapshot());
        }

        [Theory]
        [InlineData(".photo.dng")]
        [InlineData(".photo")]
        [InlineData(".")]
        [InlineData("..")]
        [InlineData(".maple")]
        public async Task ATypedRenameToAHiddenName_IsStillRefused(string typed)
        {
            var source = Path.Combine(_root, "photo.dng");
            File.WriteAllText(source, "raw");

            var refused = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.RelocateAsync(source, _root, typed, RelocateMode.Move));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, refused.Kind);
            Assert.Equal(new[] { "photo.dng" }, FolderNames());
        }

        [Fact]
        public async Task ATypedPairRenameToAHiddenName_IsStillRefused()
        {
            File.WriteAllText(Path.Combine(_root, "IMG_1.CR3"), "raw");
            File.WriteAllText(Path.Combine(_root, "IMG_1.JPG"), "jpeg");

            var refused = await Assert.ThrowsAsync<FileOperationException>(() => LocalFileOperations.RelocateStackAsync(
                Path.Combine(_root, "IMG_1.CR3"), Path.Combine(_root, "IMG_1.JPG"), _root, ".IMG_2.CR3", RelocateMode.Move));

            Assert.Equal(FileOperationErrorKind.InvalidDestination, refused.Kind);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG" }, FolderNames());
        }

        [Fact]
        public void ATypedNameThatStartsWithADot_IsStillRefusedByTheNameCheck() =>
            Assert.Throws<FileOperationException>(() => LocalFileOperations.ValidateBareFileName(".hidden"));
    }
}
