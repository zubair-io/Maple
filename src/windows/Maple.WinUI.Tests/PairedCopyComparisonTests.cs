// PairedCopyComparisonTests — the byte comparison that decides whether a
// destination edit file is the photo's own copy (so the source may be removed)
// or someone else's (so the name is taken). Real files; contents are
// non-uniform so a size-only or prefix-only comparison would be caught.

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class PairedCopyComparisonTests : PairedEditCopiesFixture
    {
        private static byte[] Noise(int length)
        {
            var bytes = new byte[length];
            new Random(6133).NextBytes(bytes);
            return bytes;
        }

        private static byte[] Flipped(byte[] bytes, int index)
        {
            var copy = (byte[])bytes.Clone();
            copy[index] ^= 0xff;
            return copy;
        }

        private string Put(string directory, string name, byte[] bytes)
        {
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, name);
            File.WriteAllBytes(path, bytes);
            return path;
        }

        [Theory]
        [InlineData(300_000, 150_000)]
        [InlineData(3_500_000, 3_499_999)]
        public void FilesIdentical_SeesADifferenceAnywhereInEqualSizedFiles(int length, int differsAt)
        {
            var original = Noise(length);
            var first = Put(Root, "a.xmp", original);
            var second = Put(Root, "b.xmp", Flipped(original, differsAt));
            var same = Put(Root, "c.xmp", original);

            Assert.False(LocalFileOperations.FilesIdentical(first, second));
            Assert.True(LocalFileOperations.FilesIdentical(first, same));
        }

        [Fact]
        public void FilesIdentical_IsFalseForAFileThatCannotBeRead()
        {
            var bytes = Noise(1000);
            var first = Put(Root, "a.xmp", bytes);
            var second = Put(Root, "b.xmp", bytes);

            using (new FileStream(second, FileMode.Open, FileAccess.Read, FileShare.None))
                Assert.False(LocalFileOperations.FilesIdentical(first, second));
        }

        [Theory]
        [InlineData(300_000, 150_000)]
        [InlineData(3_500_000, 3_499_999)]
        public async Task RestoreOverAnEqualSizedDifferentCopy_TakesTheNameAndKeepsBothFiles(int length, int differsAt)
        {
            var trashed = Noise(length);
            var edited = Flipped(trashed, differsAt);
            Put(Root, "photo.dng", new byte[] { 1 });
            Put(Root, Conflict, trashed);
            await TrashAsync("photo.dng");
            Put(Root, Conflict, edited);

            var outcome = await RestoreAsync("photo.dng");

            Assert.Equal(InRoot("photo.restored.dng"), outcome.PrimaryPath);
            Assert.Equal(edited, File.ReadAllBytes(InRoot(Conflict)));
            Assert.Equal(trashed, File.ReadAllBytes(InRoot("photo.restored (conflict from Mac).xmp")));
            Assert.False(File.Exists(InTrash(Conflict)));
        }

        [Fact]
        public async Task RestoreOverAnOccupantThatCannotBeRead_TakesTheNameAndLeavesItUntouched()
        {
            var bytes = Noise(50_000);
            Put(Root, "photo.dng", new byte[] { 1 });
            Put(Root, Conflict, bytes);
            await TrashAsync("photo.dng");
            Put(Root, Conflict, bytes);

            RelocateOutcome outcome;
            using (new FileStream(InRoot(Conflict), FileMode.Open, FileAccess.Read, FileShare.None))
                outcome = await RestoreAsync("photo.dng");

            Assert.Equal(InRoot("photo.restored.dng"), outcome.PrimaryPath);
            Assert.Equal(bytes, File.ReadAllBytes(InRoot(Conflict)));
            Assert.Equal(bytes, File.ReadAllBytes(InRoot("photo.restored (conflict from Mac).xmp")));
        }

        [Fact]
        public async Task RestoreOverAnIdenticalMultiMegabyteCopy_JoinsItAndRemovesTheTrashedSource()
        {
            var bytes = Noise(3_500_000);
            Put(Root, "photo.dng", new byte[] { 1 });
            Put(Root, Conflict, bytes);
            await TrashAsync("photo.dng");
            Put(Root, Conflict, bytes);

            var outcome = await RestoreAsync("photo.dng");

            Assert.Equal(InRoot("photo.dng"), outcome.PrimaryPath);
            Assert.Equal(bytes, File.ReadAllBytes(InRoot(Conflict)));
            Assert.False(File.Exists(InTrash(Conflict)));
            Assert.Equal(2, Directory.GetFiles(Root).Length);
        }
    }
}
