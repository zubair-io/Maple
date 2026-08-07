// RelocateSidecarFollowTests — real temp directories, real files. Covers
// BOTH sidecar-naming conventions the relocate primitive must follow (issue
// #2632): a photo's same-stem sidecar (`photo.dng` -> `photo.xmp`) and a
// video's full-name sidecar (`clip.mov` -> `clip.mov.xmp`, per
// `SidecarStore.SidecarPathFor`/`src/api/src/fs/xmp.ts`). This distinction
// is the one CLAUDE.md flags explicitly: a prior port shipped a data-loss
// bug by treating every sidecar as same-stem, which silently collides a
// video's sidecar with an unrelated same-stem photo's (Live Photo pairs:
// `IMG_1234.HEIC` + `IMG_1234.MOV`).

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RelocateSidecarFollowTests : IDisposable
    {
        private readonly string _dir;

        public RelocateSidecarFollowTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-relocate-sidecar-" + Guid.NewGuid().ToString("N"));
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
        public async Task Photo_SameStemSidecarFollowsToNewName()
        {
            var raw = WriteFile("in\\IMG_1234.CR3", "raw bytes");
            WriteFile("in\\IMG_1234.xmp", "<xmp/>photo");
            var outDir = Path.Combine(_dir, "out");

            var outcome = await LocalFileOperations.RelocateAsync(
                raw, outDir, "IMG_9999.CR3", RelocateMode.Move, CollisionPolicy.Fail);

            Assert.True(outcome.SidecarFollowed);
            Assert.Equal(Path.Combine(outDir, "IMG_9999.xmp"), outcome.SidecarPath);
            Assert.Equal("<xmp/>photo", File.ReadAllText(outcome.SidecarPath!));
            Assert.False(File.Exists(Path.Combine(_dir, "in", "IMG_1234.xmp")));
        }

        [Fact]
        public async Task Video_FullNameSidecarFollowsToNewNameKeepingExtension()
        {
            var mov = WriteFile("in\\IMG_1234.MOV", "video bytes");
            WriteFile("in\\IMG_1234.MOV.xmp", "<xmp/>video");
            var outDir = Path.Combine(_dir, "out");

            var outcome = await LocalFileOperations.RelocateAsync(
                mov, outDir, null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.True(outcome.SidecarFollowed);
            Assert.Equal(Path.Combine(outDir, "IMG_1234.MOV.xmp"), outcome.SidecarPath);
            Assert.Equal("<xmp/>video", File.ReadAllText(outcome.SidecarPath!));
        }

        [Fact]
        public async Task LivePhotoPair_VideoSidecarNeverCollidesWithSameStemPhotoSidecar()
        {
            // The exact scenario the bug hits: a still and its motion clip
            // share a stem. Relocating the video must never touch, read, or
            // overwrite the photo's own same-stem sidecar.
            var photo = WriteFile("in\\IMG_1234.HEIC", "photo bytes");
            var photoXmp = WriteFile("in\\IMG_1234.xmp", "<xmp/>photo-edits");
            var video = WriteFile("in\\IMG_1234.MOV", "video bytes");
            var videoXmp = WriteFile("in\\IMG_1234.MOV.xmp", "<xmp/>video-edits");
            var outDir = Path.Combine(_dir, "out");

            var outcome = await LocalFileOperations.RelocateAsync(
                video, outDir, null, RelocateMode.Move, CollisionPolicy.Fail);

            // Video's own sidecar followed, distinctly named.
            Assert.Equal(Path.Combine(outDir, "IMG_1234.MOV.xmp"), outcome.SidecarPath);
            // The photo and its sidecar are completely untouched.
            Assert.True(File.Exists(photo));
            Assert.Equal("<xmp/>photo-edits", File.ReadAllText(photoXmp));
            Assert.False(File.Exists(videoXmp)); // moved, not copied
        }

        [Fact]
        public async Task NoSidecar_RelocatesPrimaryOnlyWithoutError()
        {
            var raw = WriteFile("in\\IMG_5.CR3", "raw bytes");
            var outDir = Path.Combine(_dir, "out");

            var outcome = await LocalFileOperations.RelocateAsync(
                raw, outDir, null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.False(outcome.SidecarFollowed);
            Assert.Null(outcome.SidecarPath);
        }
    }
}
