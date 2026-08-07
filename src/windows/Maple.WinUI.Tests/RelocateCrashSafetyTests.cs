// RelocateCrashSafetyTests — real temp directories, real files. Exercises
// the plan/finalize split's crash-safety contract (issue #2632): the window
// between `PlanRelocateAsync` returning and `FinalizeRelocate` running is
// exactly what a process crash would leave on disk, so a test can assert
// that state directly by simply never calling `FinalizeRelocate`.

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RelocateCrashSafetyTests : IDisposable
    {
        private readonly string _dir;

        public RelocateCrashSafetyTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-relocate-crash-" + Guid.NewGuid().ToString("N"));
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

        [Fact]
        public async Task PlanOnly_SourceAndStagedCopyBothExist_MoveNeverStarted()
        {
            var src = WriteFile("in\\photo.dng", "raw bytes");
            WriteFile("in\\photo.xmp", "<xmp/>");
            var outDir = Path.Combine(_dir, "out");

            var plan = await LocalFileOperations.PlanRelocateAsync(
                src, outDir, null, RelocateMode.Move, CollisionPolicy.Fail);

            // This IS the crash window: if the app died right here, this is
            // exactly what's left on disk. Source untouched...
            Assert.True(File.Exists(src));
            Assert.True(File.Exists(Path.Combine(_dir, "in", "photo.xmp")));
            // ...and a fully verified copy already sitting at the
            // destination, safe to retry finalize on next launch.
            Assert.True(File.Exists(plan.FinalPrimaryPath));
            Assert.Equal("raw bytes", File.ReadAllText(plan.FinalPrimaryPath));
            Assert.True(File.Exists(plan.FinalSidecarPath!));
        }

        [Fact]
        public async Task Finalize_DeletesOriginalsOnlyAfterAVerifiedPlan()
        {
            var src = WriteFile("in\\photo.dng", "raw bytes");
            var outDir = Path.Combine(_dir, "out");

            var plan = await LocalFileOperations.PlanRelocateAsync(
                src, outDir, null, RelocateMode.Move, CollisionPolicy.Fail);
            Assert.True(File.Exists(src)); // still true right up to finalize

            LocalFileOperations.FinalizeRelocate(plan);

            Assert.False(File.Exists(src));
            Assert.True(File.Exists(plan.FinalPrimaryPath));
        }

        [Fact]
        public async Task RevertPlan_RemovesStagedCopyAndLeavesSourceExactlyAsItWas()
        {
            var src = WriteFile("in\\photo.dng", "raw bytes");
            WriteFile("in\\photo.xmp", "<xmp/>");
            var outDir = Path.Combine(_dir, "out");

            var plan = await LocalFileOperations.PlanRelocateAsync(
                src, outDir, null, RelocateMode.Move, CollisionPolicy.Fail);

            LocalFileOperations.RevertPlan(plan);

            foreach (var created in plan.CreatedPaths)
                Assert.False(File.Exists(created));
            Assert.True(File.Exists(src));
            Assert.Equal("raw bytes", File.ReadAllText(src));
        }

        [Fact]
        public async Task CopyMode_NeverDeletesSourceEvenAfterFinalize()
        {
            var src = WriteFile("in\\photo.dng", "raw bytes");
            var outDir = Path.Combine(_dir, "out");

            var plan = await LocalFileOperations.PlanRelocateAsync(
                src, outDir, null, RelocateMode.Copy, CollisionPolicy.Fail);
            LocalFileOperations.FinalizeRelocate(plan);

            Assert.True(File.Exists(src));
            Assert.True(File.Exists(plan.FinalPrimaryPath));
        }

        [Fact]
        public void VerifyCopy_SizeMismatch_ThrowsVerificationFailed()
        {
            var destPath = Path.Combine(_dir, "dest.bin");
            File.WriteAllText(destPath, "only three bytes short of matching");

            var ex = Assert.Throws<FileOperationException>(() =>
                LocalFileOperations.VerifyCopy(4, DateTime.UtcNow, destPath));

            Assert.Equal(FileOperationErrorKind.VerificationFailed, ex.Kind);
        }

        [Fact]
        public void VerifyCopy_MissingDestination_ThrowsVerificationFailed()
        {
            var ex = Assert.Throws<FileOperationException>(() =>
                LocalFileOperations.VerifyCopy(0, DateTime.UtcNow, Path.Combine(_dir, "never-written.bin")));

            Assert.Equal(FileOperationErrorKind.VerificationFailed, ex.Kind);
        }

        [Fact]
        public async Task SourceMissing_ThrowsBeforeTouchingAnything()
        {
            var missing = Path.Combine(_dir, "gone.dng");

            var ex = await Assert.ThrowsAsync<FileOperationException>(() =>
                LocalFileOperations.PlanRelocateAsync(
                    missing, Path.Combine(_dir, "out"), null, RelocateMode.Move, CollisionPolicy.Fail));

            Assert.Equal(FileOperationErrorKind.SourceMissing, ex.Kind);
            Assert.False(Directory.Exists(Path.Combine(_dir, "out")));
        }
    }
}
