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
    }
}
