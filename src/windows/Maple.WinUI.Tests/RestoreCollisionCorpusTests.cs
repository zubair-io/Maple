// RestoreCollisionCorpusTests — the shared restore-collision corpus
// (`test-fixtures/file-operations/restore-collisions.json`, also run by the API
// and Apple) against the real Windows restore on real temp files (#6105). The
// photo goes into the trash through the product's own trash operation.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public sealed record RestoreCollisionCase(
        string Name, string Base, List<string> Occupied, string Expected,
        List<string>? Incoming, List<string>? Unpaired);

    public sealed record RestoreCollisionCorpus(int SchemaVersion, List<RestoreCollisionCase> Cases);

    public class RestoreCollisionCorpusTests : IDisposable
    {
        private const string IncomingXml =
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><foreign:retained xmlns:foreign=\"urn:test\">case-folded bytes</foreign:retained></x:xmpmeta>";
        private const string OccupiedXml = "<foreign>occupied</foreign>";

        private readonly string _root =
            Path.Combine(Path.GetTempPath(), "maple-winui-restore-corpus-" + Guid.NewGuid().ToString("N"));

        public RestoreCollisionCorpusTests() => Directory.CreateDirectory(_root);

        public void Dispose()
        {
            try { Directory.Delete(_root, recursive: true); }
            catch (IOException) { }
        }

        private static RestoreCollisionCorpus LoadCorpus()
        {
            var repoRoot = RepoPaths.FindRepoRoot()
                ?? throw new InvalidOperationException("repository root not found from the test output directory");
            var path = Path.Combine(repoRoot, "test-fixtures", "file-operations", "restore-collisions.json");
            var corpus = JsonSerializer.Deserialize<RestoreCollisionCorpus>(
                File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new InvalidOperationException($"{path} is empty");
            if (corpus.SchemaVersion != 1)
                throw new InvalidOperationException($"Unsupported restore corpus schemaVersion: {corpus.SchemaVersion}");
            return corpus;
        }

        private const string IncomingReason =
            "#2847: a trashed photo's conflict and workflow copies stay in the original folder and are not moved back with it";
        private const string HiddenNameReason =
            "Windows refuses relocating a name that starts with a dot (ValidateBareFileName), so a hidden photo cannot be restored at all";

        private static readonly Dictionary<string, string> ExpectedDifferences = new()
        {
            ["case-folded incoming XMP"] = IncomingReason,
            ["case-folded incoming workflow XMP"] = IncomingReason,
            ["hidden extensionless"] = HiddenNameReason,
        };

        public static IEnumerable<object[]> CaseNames() => LoadCorpus().Cases.Select(c => new object[] { c.Name });

        [Theory]
        [MemberData(nameof(CaseNames))]
        public async Task RestoreNamesTheFileAndMovesSidecarsAsTheCorpusSays(string caseName)
        {
            var item = LoadCorpus().Cases.Single(c => c.Name == caseName);
            var original = $"original {item.Name}";

            var source = Path.Combine(_root, item.Base);
            File.WriteAllText(source, original);
            var trashed = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(source, source, item.Base) }, _ => _root,
                new FakeRecycleBinService { Succeeds = false });
            Assert.Equal(TrashDestinationKind.MapleTrashFolder, Assert.Single(trashed).DestinationKind);

            var trashDir = Path.Combine(_root, ".maple", "trash");
            var trashedPath = Path.Combine(trashDir, item.Base);
            Assert.True(File.Exists(trashedPath));
            foreach (var name in (item.Incoming ?? new()).Concat(item.Unpaired ?? new()))
                File.WriteAllText(Path.Combine(trashDir, name), IncomingXml);
            foreach (var name in item.Occupied)
                File.WriteAllText(Path.Combine(_root, name), OccupiedXml);
            var folderBefore = FolderNames();
            var oldStem = SidecarBase(item.Base);
            var newStem = SidecarBase(item.Expected);

            if (item.Name == "hidden extensionless")
            {
                var refused = await Assert.ThrowsAsync<FileOperationException>(
                    () => LocalFileOperations.RestoreFromMapleTrashAsync(trashedPath, _root));
                Assert.Equal(FileOperationErrorKind.InvalidDestination, refused.Kind);
                Assert.Equal(original, File.ReadAllText(trashedPath));
                Assert.Equal(folderBefore, FolderNames());
                return;
            }

            var restored = await LocalFileOperations.RestoreFromMapleTrashAsync(trashedPath, _root);

            foreach (var name in item.Occupied)
                Assert.Equal(OccupiedXml, File.ReadAllText(Path.Combine(_root, name)));
            Assert.Equal(item.Expected, Path.GetFileName(restored.PrimaryPath));
            Assert.Equal(original, File.ReadAllText(restored.PrimaryPath));

            var followers = ExpectedDifferences.ContainsKey(item.Name)
                ? (item.Incoming ?? new()).Where(n => string.Equals(n, oldStem + ".xmp", StringComparison.OrdinalIgnoreCase)).ToList()
                : item.Incoming ?? new();
            foreach (var name in followers)
            {
                var renamed = Path.Combine(_root, newStem + name[oldStem.Length..]);
                Assert.True(File.Exists(renamed), $"{item.Name}: {name} did not follow to {Path.GetFileName(renamed)}");
                Assert.Equal(IncomingXml, File.ReadAllText(renamed));
                Assert.False(File.Exists(Path.Combine(trashDir, name)), $"{item.Name}: {name} was left in the trash");
            }
            foreach (var name in (item.Unpaired ?? new()).Concat((item.Incoming ?? new()).Except(followers)))
            {
                Assert.Equal(IncomingXml, File.ReadAllText(Path.Combine(trashDir, name)));
                Assert.False(File.Exists(Path.Combine(_root, name)), $"{item.Name}: {name} appeared in the folder");
            }

            var expectedAfter = folderBefore
                .Concat(new[] { item.Expected })
                .Concat(followers.Select(n => newStem + n[oldStem.Length..]))
                .OrderBy(n => n, StringComparer.OrdinalIgnoreCase);
            Assert.Equal(expectedAfter, FolderNames(), StringComparer.OrdinalIgnoreCase);
        }

        private List<string> FolderNames() =>
            Directory.EnumerateFileSystemEntries(_root)
                .Select(p => Path.GetFileName(p)!)
                .OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();

        private static string SidecarBase(string name) =>
            Path.GetFileName(SidecarStore.SidecarPathFor(name))[..^".xmp".Length];

        [Fact]
        public void ExpectedDifferences_AreCorpusCasesByName() =>
            Assert.All(ExpectedDifferences.Keys, name => Assert.Contains(LoadCorpus().Cases, c => c.Name == name));

        [Fact]
        public async Task RestoreOfASidecarlessPhoto_LeavesAnEditFileAtTheDestinationByteIdentical()
        {
            var source = Path.Combine(_root, "photo.dng");
            File.WriteAllText(source, "photo");
            await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(source, source, "photo.dng") }, _ => _root,
                new FakeRecycleBinService { Succeeds = false });
            var edits = new byte[] { 0x3c, 0x78, 0x2f, 0x3e, 0x00, 0xff, 0xfe, 0x0a };
            File.WriteAllBytes(Path.Combine(_root, "photo.xmp"), edits);

            var restored = await LocalFileOperations.RestoreFromMapleTrashAsync(
                Path.Combine(_root, ".maple", "trash", "photo.dng"), _root);

            Assert.Equal("photo.restored.dng", Path.GetFileName(restored.PrimaryPath));
            Assert.Equal(edits, File.ReadAllBytes(Path.Combine(_root, "photo.xmp")));
        }

        [Fact]
        public async Task RestoreMove_FailsRatherThanDeleting_AnEditFileThatAppearsAfterTheNameWasResolved()
        {
            var trashed = await TrashAsync("photo.dng", "photo");
            var resolved = LocalFileOperations.ResolveRestoredBasename(trashed, _root, "photo.dng");
            Assert.Equal("photo.dng", resolved);
            File.WriteAllText(Path.Combine(_root, "photo.xmp"), "<late/>");

            var refused = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.MoveToRestoredNameAsync(trashed, _root, resolved));

            Assert.Equal(FileOperationErrorKind.DestinationExists, refused.Kind);
            Assert.Equal("<late/>", File.ReadAllText(Path.Combine(_root, "photo.xmp")));
            Assert.False(File.Exists(Path.Combine(_root, "photo.dng")));
            Assert.True(File.Exists(trashed));
            Assert.True(File.Exists(LocalFileOperations.OriginalPathMarkerFor(trashed)));
        }

        [Theory]
        [InlineData(CollisionPolicy.Fail)]
        [InlineData(CollisionPolicy.AutoSuffix)]
        public async Task Relocate_NeverReplacesAPhotoThatAppearsAtAFreeTargetUnlessToldTo(CollisionPolicy policy)
        {
            var source = Path.Combine(_root, "src", "a.dng");
            Directory.CreateDirectory(Path.GetDirectoryName(source)!);
            File.WriteAllText(source, "source");
            var target = Path.Combine(_root, "dst", "a.dng");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.WriteAllText(target, "occupant");

            if (policy == CollisionPolicy.Fail)
            {
                var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                    LocalFileOperations.RelocateAsync(source, Path.GetDirectoryName(target)!, null, RelocateMode.Move, policy));
                Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
            }
            else
            {
                var outcome = await LocalFileOperations.RelocateAsync(source, Path.GetDirectoryName(target)!, null, RelocateMode.Move, policy);
                Assert.NotEqual(target, outcome.PrimaryPath);
            }
            Assert.Equal("occupant", File.ReadAllText(target));
        }

        [Fact]
        public void CopyVerified_WithoutOverwrite_RefusesAnOccupantAndLeavesNoPartialFile()
        {
            var source = Path.Combine(_root, "s.dng");
            var target = Path.Combine(_root, "t.dng");
            File.WriteAllText(source, "source");
            File.WriteAllText(target, "occupant");

            var ex = Assert.Throws<FileOperationException>(() => LocalFileOperations.CopyVerified(source, target, overwrite: false));

            Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
            Assert.Equal("occupant", File.ReadAllText(target));
            Assert.Equal("source", File.ReadAllText(source));
            Assert.Equal(new[] { "s.dng", "t.dng" }, FolderNames().OrderBy(n => n, StringComparer.Ordinal));
        }

        private async Task<string> TrashAsync(string name, string content)
        {
            var path = Path.Combine(_root, name);
            File.WriteAllText(path, content);
            await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(path, path, name) }, _ => _root,
                new FakeRecycleBinService { Succeeds = false });
            return Path.Combine(_root, ".maple", "trash", name);
        }

        [Fact]
        public async Task OneHalfOfASharedEditFile_RejoinsTheIdenticalEditFileAtItsOwnName()
        {
            File.WriteAllText(Path.Combine(_root, "photo.jpg"), "jpeg");
            File.WriteAllText(Path.Combine(_root, "photo.xmp"), "<shared/>");
            var trashed = await TrashAsync("photo.dng", "raw");
            Assert.True(File.Exists(Path.Combine(_root, ".maple", "trash", "photo.xmp")));

            var restored = await LocalFileOperations.RestoreFromMapleTrashAsync(trashed, _root);

            Assert.Equal(Path.Combine(_root, "photo.dng"), restored.PrimaryPath);
            Assert.Equal("<shared/>", File.ReadAllText(Path.Combine(_root, "photo.xmp")));
            Assert.False(File.Exists(Path.Combine(_root, ".maple", "trash", "photo.xmp")));
            Assert.Equal(new[] { ".maple", "photo.dng", "photo.jpg", "photo.xmp" },
                FolderNames().OrderBy(n => n, StringComparer.Ordinal));
        }

        [Fact]
        public async Task OneHalfOfASharedEditFile_IsRestoredUnderANewNameWhenTheEditFileChanged()
        {
            File.WriteAllText(Path.Combine(_root, "photo.jpg"), "jpeg");
            File.WriteAllText(Path.Combine(_root, "photo.xmp"), "<shared/>");
            var trashed = await TrashAsync("photo.dng", "raw");
            File.WriteAllText(Path.Combine(_root, "photo.xmp"), "<edited after trashing/>");

            var restored = await LocalFileOperations.RestoreFromMapleTrashAsync(trashed, _root);

            Assert.Equal(Path.Combine(_root, "photo.restored.dng"), restored.PrimaryPath);
            Assert.Equal("<shared/>", File.ReadAllText(Path.Combine(_root, "photo.restored.xmp")));
            Assert.Equal("<edited after trashing/>", File.ReadAllText(Path.Combine(_root, "photo.xmp")));
        }

        [Fact]
        public async Task TwoSameStemPhotosTrashedTogether_BothComeBackUnderTheirOwnNames()
        {
            File.WriteAllText(Path.Combine(_root, "photo.dng"), "raw");
            File.WriteAllText(Path.Combine(_root, "photo.tif"), "tif");
            File.WriteAllText(Path.Combine(_root, "photo.xmp"), "<shared/>");
            await TrashSelectionLogic.ApplySequentialAsync(
                new[]
                {
                    new TrashSourceItem(Path.Combine(_root, "photo.dng"), Path.Combine(_root, "photo.dng"), "photo.dng"),
                    new TrashSourceItem(Path.Combine(_root, "photo.tif"), Path.Combine(_root, "photo.tif"), "photo.tif"),
                },
                _ => _root, new FakeRecycleBinService { Succeeds = false });
            var trashDir = Path.Combine(_root, ".maple", "trash");

            var first = await LocalFileOperations.RestoreFromMapleTrashAsync(Path.Combine(trashDir, "photo.dng"), _root);
            var second = await LocalFileOperations.RestoreFromMapleTrashAsync(Path.Combine(trashDir, "photo.tif"), _root);

            Assert.Equal(Path.Combine(_root, "photo.dng"), first.PrimaryPath);
            Assert.Equal(Path.Combine(_root, "photo.tif"), second.PrimaryPath);
            Assert.Equal("<shared/>", File.ReadAllText(Path.Combine(_root, "photo.xmp")));
        }

        [Theory]
        [InlineData(".photo", ".photo.restored")]
        [InlineData(".photo.dng", ".photo.restored.dng")]
        [InlineData("photo", "photo.restored")]
        [InlineData("PHOTO.DNG", "PHOTO.restored.DNG")]
        public void PickFreeRestoredBasename_SplitsTheStemAndExtensionLikeTheServer(string name, string expected)
        {
            File.WriteAllText(Path.Combine(_root, name), "taken");
            Assert.Equal(expected, LocalFileOperations.PickFreeRestoredBasename(
                Path.Combine(_root, ".maple", "trash", name), _root, LocalFileOperations.FolderNames(_root), name));
        }

        [Fact]
        public async Task TrashIn_LeavesConflictAndWorkflowCopiesInTheOriginalFolder()
        {
            const string workflow = "photo.v12345678-1234-1234-1234-123456789abc.xmp";
            var source = Path.Combine(_root, "photo.dng");
            File.WriteAllText(source, "photo");
            foreach (var name in new[] { "photo.xmp", "photo (conflict from Mac).xmp", workflow })
                File.WriteAllText(Path.Combine(_root, name), name);

            await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(source, source, "photo.dng") }, _ => _root,
                new FakeRecycleBinService { Succeeds = false });

            var trashDir = Path.Combine(_root, ".maple", "trash");
            Assert.Equal(new[] { "photo.dng", "photo.xmp" },
                Directory.EnumerateFiles(trashDir).Select(Path.GetFileName)
                    .Where(n => !n!.EndsWith(".origpath")).OrderBy(n => n, StringComparer.Ordinal));
            Assert.Equal("photo (conflict from Mac).xmp", File.ReadAllText(Path.Combine(_root, "photo (conflict from Mac).xmp")));
            Assert.Equal(workflow, File.ReadAllText(Path.Combine(_root, workflow)));
        }

        [Theory]
        [InlineData("IMG_1 (conflict from Mac).xmp", true)]
        [InlineData("IMG_1 (conflict from Mac) (2).xmp", true)]
        [InlineData("img_1.v12345678-1234-1234-1234-123456789abc.xmp", true)]
        [InlineData("IMG_1.v2.xmp", false)]
        [InlineData("IMG_1 (2).xmp", false)]
        [InlineData("IMG_1.v12345678-1234-1234-1234-123456789ABF.xmp", false)]
        public async Task RestoringAPair_TreatsAdoptableEditFilesAtTheDestinationAsTakenNames(string present, bool takesTheName)
        {
            var raw = Path.Combine(_root, "IMG_1.CR3");
            var jpeg = Path.Combine(_root, "IMG_1.JPG");
            File.WriteAllText(raw, "raw");
            File.WriteAllText(jpeg, "jpeg");
            File.WriteAllText(Path.Combine(_root, "IMG_1.xmp"), "<mine/>");
            await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(raw, raw, "IMG_1.CR3", jpeg) }, _ => _root,
                new FakeRecycleBinService { Succeeds = false });
            File.WriteAllText(Path.Combine(_root, present), "<foreign/>");

            var outcome = await LocalFileOperations.RestoreFromMapleTrashAsync(
                Path.Combine(_root, ".maple", "trash", "IMG_1.CR3"), _root);

            var stem = takesTheName ? "IMG_1.restored" : "IMG_1";
            Assert.Equal(Path.Combine(_root, stem + ".CR3"), outcome.PrimaryPath);
            Assert.Equal(Path.Combine(_root, stem + ".JPG"), outcome.CompanionPath);
            Assert.Equal("<mine/>", File.ReadAllText(Path.Combine(_root, stem + ".xmp")));
            Assert.Equal("<foreign/>", File.ReadAllText(Path.Combine(_root, present)));
        }
    }
}
