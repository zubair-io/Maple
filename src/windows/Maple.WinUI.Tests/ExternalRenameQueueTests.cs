// ExternalRenameQueueTests — a rename the stability probe finds locked must
// not split a group of renames that read one sidecar (#6072): deciding half
// of them first would move the sidecar the other half still needs.

using System;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class ExternalRenameQueueTests : IDisposable
    {
        private readonly string _dir;

        public ExternalRenameQueueTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-rename-queue-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
            File.WriteAllText(P("IMG.xmp"), "<edits/>");
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string P(string name) => Path.Combine(_dir, name);

        private LibraryChangeQueue.Resolved Resolve(string locked, params (string Old, string New)[] renames)
        {
            var queue = new LibraryChangeQueue();
            foreach (var (old, @new) in renames) queue.QueueRenamed(P(old), P(@new));
            return LibraryChangeQueue.Resolve(queue.Drain(),
                path => path == P(locked) ? LibraryChangeQueue.FileStability.Locked : LibraryChangeQueue.FileStability.Stable);
        }

        private static string[] Held(LibraryChangeQueue.Resolved resolved, Func<string, string> name) =>
            resolved.UnstableRenamed.Select(pair => name(pair.Key)).OrderBy(k => k, StringComparer.Ordinal).ToArray();

        [Fact]
        public void LockedMember_HoldsBackTheRenamesThatShareItsOldSidecar()
        {
            var resolved = Resolve("Alpha.CR3", ("IMG.CR3", "Alpha.CR3"), ("IMG.jpg", "Beta.jpg"));

            Assert.Empty(resolved.Renamed);
            Assert.Equal(new[] { "IMG.CR3", "IMG.jpg" }, Held(resolved, Path.GetFileName!));
        }

        [Fact]
        public void LockedSecondStepOfAShift_HoldsBackTheFirstStep()
        {
            File.WriteAllText(P("2.xmp"), "<two/>");
            File.WriteAllText(P("3.xmp"), "<three/>");

            var resolved = Resolve("3.jpg", ("3.jpg", "4.jpg"), ("2.jpg", "3.jpg"));

            Assert.Empty(resolved.Renamed);
            Assert.Equal(new[] { "2.jpg", "3.jpg" }, Held(resolved, Path.GetFileName!));
        }

        [Fact]
        public void LockedFirstStepOfAShift_HoldsBackTheSecondStep()
        {
            File.WriteAllText(P("2.xmp"), "<two/>");
            File.WriteAllText(P("3.xmp"), "<three/>");

            var resolved = Resolve("4.jpg", ("3.jpg", "4.jpg"), ("2.jpg", "3.jpg"));

            Assert.Empty(resolved.Renamed);
            Assert.Equal(new[] { "2.jpg", "3.jpg" }, Held(resolved, Path.GetFileName!));
        }

        [Fact]
        public void LinksAreFollowedTransitively()
        {
            var resolved = Resolve("4.jpg", ("3.jpg", "4.jpg"), ("2.jpg", "3.jpg"), ("1.jpg", "2.jpg"));

            Assert.Empty(resolved.Renamed);
            Assert.Equal(3, resolved.UnstableRenamed.Count);
        }

        [Fact]
        public void LockedMember_DoesNotHoldBackUnrelatedRenames()
        {
            var resolved = Resolve("Alpha.CR3", ("IMG.CR3", "Alpha.CR3"), ("Other.jpg", "Beta.jpg"));

            Assert.Equal(new[] { (P("Other.jpg"), P("Beta.jpg")) }, resolved.Renamed);
            Assert.Equal(new[] { "IMG.CR3" }, Held(resolved, Path.GetFileName!));
        }
    }
}
