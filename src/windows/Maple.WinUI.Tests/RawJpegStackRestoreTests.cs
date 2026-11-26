// RawJpegStackRestoreTests — restoring a RAW+JPEG pair out of `.maple/trash`
// (#5050, #5848). The two halves come back together under one name, so a
// JPEG can never be re-paired with a different RAW that arrived in the
// original folder while the pair sat in the trash. Real temp directories and
// files; only the Recycle Bin shell call is faked.

using System;
using System.IO;
using System.Linq;
using System.Text;
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

        private (string Raw, string Jpeg) TrashHalvesWithDifferentSidecarSpellings()
        {
            var composed = "Café".Normalize(NormalizationForm.FormC);
            var decomposed = "Café".Normalize(NormalizationForm.FormD);
            var raw = Write("raw", ".maple", "trash", "Album", composed + ".CR3");
            var jpeg = Write("jpeg", ".maple", "trash", "Album", decomposed + ".JPG");
            File.WriteAllText(raw + ".origpath", Path.Combine("Album", composed + ".CR3"));
            File.WriteAllText(jpeg + ".origpath", Path.Combine("Album", decomposed + ".JPG"));
            return (raw, jpeg);
        }

        [Fact]
        public void HalvesThatReadDifferentSidecars_AreNotTrashedCompanions()
        {
            var (raw, jpeg) = TrashHalvesWithDifferentSidecarSpellings();

            Assert.Null(LocalFileOperations.TrashedCompanionOf(raw, _root));
            Assert.Null(LocalFileOperations.TrashedCompanionOf(jpeg, _root));
        }

        [Fact]
        public async Task HalvesThatReadDifferentSidecars_AreRestoredIndividually()
        {
            var (raw, jpeg) = TrashHalvesWithDifferentSidecarSpellings();

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(raw, _root);

            Assert.Null(outcome.CompanionPath);
            Assert.Single(Names("Album"));
            Assert.True(File.Exists(jpeg));
        }

        [Fact]
        public void TheFoldAndTheRestoreDecideAPairWithTheSameFunction()
        {
            var (raw, jpeg) = TrashHalvesWithDifferentSidecarSpellings();

            Assert.Empty(RawJpegPairing.LocalPairs(new[] { raw, jpeg }));
            Assert.Single(RawJpegPairing.Pairs(new[] { raw, jpeg }));
        }

        private static TrashListItem ListItem(string trashPath, string root) =>
            new(root, trashPath, null, Path.GetFileName(trashPath), Path.GetFileName(trashPath), 0, DateTime.UtcNow);

        [Fact]
        public async Task RestoringOnlyTheRaw_ReportsTheJpegItBroughtBack()
        {
            await TrashThePairAsync();

            var outcomes = await TrashSelectionLogic.ApplyRestoreSequentialAsync(
                new[] { ListItem(TrashPath("IMG_1.CR3"), _root) });

            var outcome = Assert.Single(outcomes);
            Assert.Equal(P("Album", "IMG_1.JPG"), outcome.CompanionNewPath);
            Assert.Equal("Restored IMG_1.CR3 and IMG_1.JPG.", TrashSelectionLogic.DescribeRestore(outcomes));
        }

        [Fact]
        public async Task SelectingBothHalves_CountsTwoFilesAndNamesNothingTwice()
        {
            await TrashThePairAsync();

            var outcomes = await TrashSelectionLogic.ApplyRestoreSequentialAsync(new[]
            {
                ListItem(TrashPath("IMG_1.CR3"), _root),
                ListItem(TrashPath("IMG_1.JPG"), _root),
            });

            Assert.All(outcomes, outcome => Assert.True(outcome.Ok));
            Assert.Equal("Restored 2 photos.", TrashSelectionLogic.DescribeRestore(outcomes));
        }

        [Fact]
        public void ARestoreWithAFailure_CountsTheCompanionAmongTheRestoredFiles()
        {
            var outcomes = new[]
            {
                new RestoreItemOutcome("a", "A.CR3", true, P("Album", "A.CR3"), null, P("Album", "A.JPG")),
                new RestoreItemOutcome("b", "B.CR3", false, null, "blocked"),
            };

            Assert.Equal("Restored 2 of 3 photos. 1 failed.", TrashSelectionLogic.DescribeRestore(outcomes));
        }

        [Fact]
        public void SeveralRestoredPairs_AreEachNamed()
        {
            var outcomes = new[]
            {
                new RestoreItemOutcome("a", "A.CR3", true, P("Album", "A.CR3"), null, P("Album", "A.JPG")),
                new RestoreItemOutcome("b", "B.CR3", true, P("Album", "B.CR3"), null, P("Album", "B.JPG")),
            };

            Assert.Equal(
                "Restored 4 photos, including A.CR3 and A.JPG; B.CR3 and B.JPG.",
                TrashSelectionLogic.DescribeRestore(outcomes));
        }

        [Fact]
        public void PlainRestores_KeepTheExistingSummary()
        {
            var one = new[] { new RestoreItemOutcome("a", "A.CR3", true, P("Album", "A.CR3"), null) };

            Assert.Equal("Restored 1 photo.", TrashSelectionLogic.DescribeRestore(one));
        }
    }
}
