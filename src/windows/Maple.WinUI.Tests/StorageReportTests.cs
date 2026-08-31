// StorageReportTests — the WinUI-free byte formatting + directory-size
// probe behind the Settings window's Storage section (MN3, #3052).
// Directory probing uses real temp directories per the repo's no-mocks
// preference for filesystem-contract code.

using System;
using System.IO;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class StorageReportTests
    {
        [Theory]
        [InlineData(0, "0 B")]
        [InlineData(-5, "0 B")]                        // failed partial probe reads as empty
        [InlineData(512, "512 B")]
        [InlineData(1024, "1 KB")]
        [InlineData(320_000, "313 KB")]
        [InlineData(1_500_000, "1.4 MB")]
        [InlineData(1_073_741_824, "1 GB")]
        [InlineData(1_610_612_736, "1.5 GB")]
        public void FormatBytes_HumanReadable(long bytes, string expected)
        {
            Assert.Equal(expected, StorageReport.FormatBytes(bytes));
        }

        [Fact]
        public void TryDirectorySizeBytes_MissingDirectory_ReturnsNull()
        {
            var missing = Path.Combine(Path.GetTempPath(), "maple-storage-report-" + Guid.NewGuid().ToString("N"));
            Assert.Null(StorageReport.TryDirectorySizeBytes(missing));
        }

        [Fact]
        public void TryDirectorySizeBytes_SumsFilesRecursively()
        {
            var root = Path.Combine(Path.GetTempPath(), "maple-storage-report-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(Path.Combine(root, "nested"));
                File.WriteAllBytes(Path.Combine(root, "a.bin"), new byte[100]);
                File.WriteAllBytes(Path.Combine(root, "nested", "b.bin"), new byte[250]);
                Assert.Equal(350, StorageReport.TryDirectorySizeBytes(root));
            }
            finally
            {
                Directory.Delete(root, recursive: true);
            }
        }

        [Fact]
        public void TryDirectorySizeBytes_CountsHiddenFiles()
        {
            // EnumerationOptions' DEFAULT AttributesToSkip silently drops
            // hidden/system files — the probe overrides it to 0 so cache
            // contents count regardless of attributes. This pins that.
            var root = Path.Combine(Path.GetTempPath(), "maple-storage-report-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(root);
                var hidden = Path.Combine(root, "hidden.bin");
                File.WriteAllBytes(hidden, new byte[64]);
                File.SetAttributes(hidden, FileAttributes.Hidden);
                Assert.Equal(64, StorageReport.TryDirectorySizeBytes(root));
            }
            finally
            {
                Directory.Delete(root, recursive: true);
            }
        }

        [Fact]
        public void TryMapleThumbsSizeBytes_MissingRoot_ReturnsNull()
        {
            var missing = Path.Combine(Path.GetTempPath(), "maple-storage-report-" + Guid.NewGuid().ToString("N"));
            Assert.Null(StorageReport.TryMapleThumbsSizeBytes(missing));
        }

        [Fact]
        public void TryMapleThumbsSizeBytes_SumsEveryNestedThumbsDir_AndOnlyThose()
        {
            // The shared cache is per-folder (`<folder>\.maple\thumbs`,
            // #3083), so a library root holds many of them at any depth.
            // Photos themselves, and non-thumbs `.maple` content (trash),
            // must NOT count.
            var root = Path.Combine(Path.GetTempPath(), "maple-storage-report-" + Guid.NewGuid().ToString("N"));
            try
            {
                void Write(string relPath, int bytes)
                {
                    var full = Path.Combine(root, relPath);
                    Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                    File.WriteAllBytes(full, new byte[bytes]);
                }

                Write(@".maple\thumbs\aaaa.avif", 100);
                Write(@"2026\tokyo\.maple\thumbs\bbbb.avif", 250);
                Write(@"2026\tokyo\IMG_1.dng", 5000);              // a photo — not cache
                Write(@".maple\trash\old\IMG_2.dng", 7000);        // .maple, but not thumbs

                Assert.Equal(350, StorageReport.TryMapleThumbsSizeBytes(root));
            }
            finally
            {
                Directory.Delete(root, recursive: true);
            }
        }

        [Fact]
        public void TryMapleThumbsSizeBytes_RootWithoutAnyMapleDirs_ReturnsZero()
        {
            // An existing root that simply has no caches yet measures as 0 —
            // distinct from null (root missing/unreadable).
            var root = Path.Combine(Path.GetTempPath(), "maple-storage-report-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(Path.Combine(root, "empty-album"));
                Assert.Equal(0, StorageReport.TryMapleThumbsSizeBytes(root));
            }
            finally
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }
}
