// PairedEditCopiesFixture — a real temp library for the trash and restore
// tests of a photo's conflict and workflow edit copies (#6133). The photo goes
// into the Maple trash through the product's own trash operation (only the
// Recycle Bin shell call is faked), and every assertion about "nothing was
// lost" compares the whole tree by name and bytes.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests.Support
{
    public abstract class PairedEditCopiesFixture : IDisposable
    {
        protected const string Workflow = "photo.v12345678-1234-1234-1234-123456789abc.xmp";
        protected const string Conflict = "photo (conflict from Mac).xmp";
        protected const string NumberedConflict = "photo (conflict from Mac) (2).xmp";

        protected readonly string Root =
            Path.Combine(Path.GetTempPath(), "maple-winui-paired-copies-" + Guid.NewGuid().ToString("N"));

        protected PairedEditCopiesFixture() => Directory.CreateDirectory(Root);

        public void Dispose()
        {
            try { Directory.Delete(Root, recursive: true); }
            catch (IOException) { }
        }

        protected string TrashDir => Path.Combine(Root, ".maple", "trash");

        protected string InRoot(string name) => Path.Combine(Root, name);

        protected string InTrash(string name) => Path.Combine(TrashDir, name);

        protected static void WriteEach(string directory, params string[] names)
        {
            Directory.CreateDirectory(directory);
            foreach (var name in names)
                File.WriteAllText(Path.Combine(directory, name), BytesOf(name));
        }

        protected static string BytesOf(string name) => "bytes of " + name;

        /// <summary>Every file under the library by relative path and text,
        /// the `.origpath` bookkeeping markers left out unless asked for.</summary>
        protected SortedDictionary<string, string> Tree(bool withMarkers = false) =>
            new(Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories)
                    .Where(path => withMarkers || !path.EndsWith(".origpath", StringComparison.Ordinal))
                    .ToDictionary(
                        path => Path.GetRelativePath(Root, path).Replace('\\', '/'),
                        File.ReadAllText),
                StringComparer.Ordinal);

        protected static void AssertTree(
            IReadOnlyDictionary<string, string> expected, IReadOnlyDictionary<string, string> actual) =>
            Assert.Equal(
                expected.OrderBy(pair => pair.Key, StringComparer.Ordinal),
                actual.OrderBy(pair => pair.Key, StringComparer.Ordinal));

        protected static Dictionary<string, string> Files(string folderPrefix, params string[] names) =>
            names.ToDictionary(name => folderPrefix + name, BytesOf);

        protected async Task<TrashItemOutcome> TrashAsync(string name, string? companion = null)
        {
            var path = InRoot(name);
            var results = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(path, path, name, companion == null ? null : InRoot(companion)) },
                _ => Root, new FakeRecycleBinService { Succeeds = false });
            var result = Assert.Single(results);
            Assert.True(result.Kind == TrashOutcomeKind.Trashed, result.Error);
            Assert.Equal(TrashDestinationKind.MapleTrashFolder, result.DestinationKind);
            return result;
        }

        protected Task<RelocateOutcome> RestoreAsync(string trashedName) =>
            LocalFileOperations.RestoreFromMapleTrashAsync(InTrash(trashedName), Root);
    }
}
