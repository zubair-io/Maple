// RawJpegStackRestoreTests — restoring a RAW+JPEG pair out of `.maple/trash`
// (#5050, #5848). The two halves come back together under one name, so a
// JPEG can never be re-paired with a different RAW that arrived in the
// original folder while the pair sat in the trash. Real temp directories and
// files; only the Recycle Bin shell call is faked.

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegStackRestoreTests : IDisposable
    {
        private readonly string _root;

        public RawJpegStackRestoreTests()
        {
            _root = Path.Combine(Path.GetTempPath(), "maple-winui-stack-restore-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(P("Album"));
        }

        public void Dispose()
        {
            try { Directory.Delete(_root, recursive: true); }
            catch (IOException) { }
        }

        private string P(params string[] parts) => Path.Combine(_root, Path.Combine(parts));

        private string Write(string content, params string[] parts)
        {
            var full = P(parts);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        private string[] Names(params string[] folder) =>
            Directory.Exists(P(folder))
                ? Directory.EnumerateFiles(P(folder))
                    .Select(Path.GetFileName)
                    .Where(name => !name!.EndsWith(".origpath", StringComparison.Ordinal))
                    .OrderBy(n => n, StringComparer.Ordinal).ToArray()!
                : Array.Empty<string>();

        private async Task TrashThePairAsync()
        {
            var raw = Write("raw", "Album", "IMG_1.CR3");
            var jpeg = Write("jpeg", "Album", "IMG_1.JPG");
            Write("<old edits/>", "Album", "IMG_1.xmp");
            var outcomes = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(raw, raw, "IMG_1.CR3", jpeg) },
                _ => _root,
                new FakeRecycleBinService { Succeeds = false });
            Assert.Equal(TrashOutcomeKind.Trashed, Assert.Single(outcomes).Kind);
            Assert.Empty(Names("Album"));
        }

        private string TrashPath(string name) => P(".maple", "trash", "Album", name);

        [Fact]
        public async Task RestoringTheRaw_BringsTheJpegAndSidecarBackTogether()
        {
            await TrashThePairAsync();

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(TrashPath("IMG_1.CR3"), _root);

            Assert.Equal(P("Album", "IMG_1.CR3"), outcome.PrimaryPath);
            Assert.Equal(P("Album", "IMG_1.JPG"), outcome.CompanionPath);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("Album"));
            Assert.Equal("<old edits/>", File.ReadAllText(P("Album", "IMG_1.xmp")));
            Assert.Empty(Names(".maple", "trash", "Album"));
        }

        [Fact]
        public async Task RestoringTheJpeg_BringsTheRawBackTooUnderOneName()
        {
            await TrashThePairAsync();

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(TrashPath("IMG_1.JPG"), _root);

            Assert.Equal(P("Album", "IMG_1.JPG"), outcome.PrimaryPath);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("Album"));
            Assert.Empty(Names(".maple", "trash", "Album"));
        }

        [Fact]
        public async Task AnUnrelatedRawInTheFolder_NeverTakesTheRestoredJpeg()
        {
            await TrashThePairAsync();
            Write("unrelated raw", "Album", "IMG_1.CR3");
            Write("<unrelated edits/>", "Album", "IMG_1.xmp");

            await LocalFileOperations.RestoreFromMapleTrashAsync(TrashPath("IMG_1.CR3"), _root);

            Assert.Equal(
                new[] { "IMG_1.CR3", "IMG_1.restored.CR3", "IMG_1.restored.JPG", "IMG_1.restored.xmp", "IMG_1.xmp" },
                Names("Album"));
            Assert.Equal("unrelated raw", File.ReadAllText(P("Album", "IMG_1.CR3")));
            Assert.Equal("<unrelated edits/>", File.ReadAllText(P("Album", "IMG_1.xmp")));
            Assert.Equal("raw", File.ReadAllText(P("Album", "IMG_1.restored.CR3")));
            Assert.Equal("jpeg", File.ReadAllText(P("Album", "IMG_1.restored.JPG")));
            Assert.Equal("<old edits/>", File.ReadAllText(P("Album", "IMG_1.restored.xmp")));
            Assert.Empty(Names(".maple", "trash", "Album"));
        }

        [Fact]
        public async Task ATakenJpegName_MovesTheWholePairToTheRestoredName()
        {
            await TrashThePairAsync();
            Write("another jpeg", "Album", "IMG_1.JPG");

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(TrashPath("IMG_1.CR3"), _root);

            Assert.Equal(P("Album", "IMG_1.restored.CR3"), outcome.PrimaryPath);
            Assert.Equal(P("Album", "IMG_1.restored.JPG"), outcome.CompanionPath);
            Assert.Equal("another jpeg", File.ReadAllText(P("Album", "IMG_1.JPG")));
        }

        [Fact]
        public async Task ARestoredRawThatWasEdited_IsNotTouchedWhenTheJpegIsRestoredAfterwards()
        {
            await TrashThePairAsync();
            Write("unrelated raw", "Album", "IMG_1.CR3");
            await LocalFileOperations.RestoreFromMapleTrashAsync(TrashPath("IMG_1.CR3"), _root);
            File.WriteAllText(P("Album", "IMG_1.restored.xmp"), "<edited after restore/>");

            var failure = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.RestoreFromMapleTrashAsync(TrashPath("IMG_1.JPG"), _root));

            Assert.Equal(FileOperationErrorKind.SourceMissing, failure.Kind);
            Assert.Equal(
                new[] { "IMG_1.CR3", "IMG_1.restored.CR3", "IMG_1.restored.JPG", "IMG_1.restored.xmp" },
                Names("Album"));
            Assert.Equal("<edited after restore/>", File.ReadAllText(P("Album", "IMG_1.restored.xmp")));
        }

        [Fact]
        public async Task TrashedCompanionOf_NamesTheOtherHalfOfATrashedPair()
        {
            await TrashThePairAsync();

            Assert.Equal(TrashPath("IMG_1.JPG"), LocalFileOperations.TrashedCompanionOf(TrashPath("IMG_1.CR3"), _root));
            Assert.Equal(TrashPath("IMG_1.CR3"), LocalFileOperations.TrashedCompanionOf(TrashPath("IMG_1.JPG"), _root));
        }

        [Fact]
        public async Task AJpegTrashedFromAnotherFolder_IsNotTheRawsCompanion()
        {
            var raw = Write("raw", "Album", "IMG_1.CR3");
            await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(raw, raw, "IMG_1.CR3") }, _ => _root,
                new FakeRecycleBinService { Succeeds = false });
            Write("jpeg", ".maple", "trash", "Album", "IMG_1.JPG");
            File.WriteAllText(P(".maple", "trash", "Album", "IMG_1.JPG.origpath"), Path.Combine("Other", "IMG_1.JPG"));

            Assert.Null(LocalFileOperations.TrashedCompanionOf(TrashPath("IMG_1.CR3"), _root));

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(TrashPath("IMG_1.CR3"), _root);

            Assert.Null(outcome.CompanionPath);
            Assert.Equal(new[] { "IMG_1.CR3" }, Names("Album"));
            Assert.Equal(new[] { "IMG_1.JPG" }, Names(".maple", "trash", "Album"));
        }
    }
}
