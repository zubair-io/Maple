// CaseSensitiveSidecarTests — the shared-sidecar rule (#4758) where the folder
// keeps names that differ only in case apart (per-directory case-sensitive
// NTFS, case-sensitive APFS): x.CR3 reads x.xmp and X.JPG reads X.xmp, two
// separate files. Each test probes the temp folder and asserts the outcome
// for the case rule it actually has; point TMPDIR at a case-sensitive volume
// to exercise the separate-sidecar branch.

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class CaseSensitiveSidecarTests : IDisposable
    {
        private readonly string _dir;

        public CaseSensitiveSidecarTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-case-sidecar-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
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

        private string[] Names(string folder) =>
            Directory.EnumerateFiles(P(folder)).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToArray();

        [Fact]
        public async Task Replace_IncomingWithoutSidecar_ADifferentlyCasedSiblingOwnsOnlyItsOwnSidecar()
        {
            var raw = Write("new", "src", "x.CR3");
            Write("old", "album", "x.CR3");
            Write("<stale/>", "album", "x.xmp");
            Write("jpg", "album", "X.JPG");
            var foldsCase = File.Exists(P("album", "X.CR3"));
            if (!foldsCase) Write("<jpg/>", "album", "X.xmp");

            await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Replace);

            Assert.Equal(
                foldsCase ? new[] { "X.JPG", "x.CR3", "x.xmp" } : new[] { "X.JPG", "X.xmp", "x.CR3" },
                Names("album"));
            Assert.Equal(foldsCase ? "<stale/>" : "<jpg/>", File.ReadAllText(P("album", foldsCase ? "x.xmp" : "X.xmp")));
        }

        [Fact]
        public async Task CaseOnlyRename_OntoAnUnrelatedSidecarName_FailPolicyThrowsWithNothingMoved()
        {
            var raw = Write("raw", "photos", "x.CR3");
            Write("<own/>", "photos", "x.xmp");
            var foldsCase = File.Exists(P("photos", "X.CR3"));
            if (foldsCase) return;
            Write("<unrelated/>", "photos", "X.xmp");

            var ex = await Assert.ThrowsAsync<FileOperationException>(() => LocalFileOperations.RelocateAsync(
                raw, P("photos"), "X.CR3", RelocateMode.Move, CollisionPolicy.Fail));

            Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
            Assert.Equal(new[] { "X.xmp", "x.CR3", "x.xmp" }, Names("photos"));
            Assert.Equal("<own/>", File.ReadAllText(P("photos", "x.xmp")));
            Assert.Equal("<unrelated/>", File.ReadAllText(P("photos", "X.xmp")));
        }

        [Fact]
        public async Task CaseOnlyRename_OntoAnUnrelatedSidecarName_FollowsTheCollisionPolicy()
        {
            var raw = Write("raw", "photos", "x.CR3");
            Write("<own/>", "photos", "x.xmp");
            var foldsCase = File.Exists(P("photos", "X.CR3"));
            if (foldsCase) return;
            Write("<unrelated/>", "photos", "X.xmp");

            var outcome = await LocalFileOperations.RelocateAsync(
                raw, P("photos"), "X.CR3", RelocateMode.Move, CollisionPolicy.AutoSuffix);

            Assert.True(outcome.RenamedDueToCollision);
            Assert.Equal(new[] { "X.1.CR3", "X.1.xmp", "X.xmp" }, Names("photos"));
            Assert.Equal("<own/>", File.ReadAllText(P("photos", "X.1.xmp")));
            Assert.Equal("<unrelated/>", File.ReadAllText(P("photos", "X.xmp")));
        }

        [Fact]
        public async Task CaseOnlyRename_OntoAnUnrelatedSidecarName_ReplaceOverwritesIt()
        {
            var raw = Write("raw", "photos", "x.CR3");
            Write("<own/>", "photos", "x.xmp");
            var foldsCase = File.Exists(P("photos", "X.CR3"));
            if (foldsCase) return;
            Write("<unrelated/>", "photos", "X.xmp");

            await LocalFileOperations.RelocateAsync(
                raw, P("photos"), "X.CR3", RelocateMode.Move, CollisionPolicy.Replace);

            Assert.Equal(new[] { "X.CR3", "X.xmp" }, Names("photos"));
            Assert.Equal("<own/>", File.ReadAllText(P("photos", "X.xmp")));
        }

        [Fact]
        public async Task Replace_IncomingDifferentlyCasedName_OnlyAFoldingFolderCountsTheReplacedPhotoAsTheSameFile()
        {
            var raw = Write("new", "src", "img.CR3");
            Write("old", "album", "IMG.CR3");
            Write("<old/>", "album", "IMG.xmp");
            var foldsCase = File.Exists(P("album", "img.CR3"));

            await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Replace);

            // Folding: img.CR3 replaced IMG.CR3 and the stale IMG.xmp must not
            // be adopted. Case-sensitive: a different photo that merely sits
            // beside IMG.CR3, whose IMG.xmp stays.
            Assert.Equal(!foldsCase, File.Exists(P("album", "IMG.xmp")));
            Assert.False(File.Exists(P("album", "img.xmp")));
        }
    }
}
