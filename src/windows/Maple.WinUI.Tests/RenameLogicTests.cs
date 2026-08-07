// RenameLogicTests — pure stem/extension helpers for inline single-asset
// rename (#2639). No filesystem, no FFI: these only cover RenameLogic's own
// string logic. The relocate call itself (collision policy, case-only
// rename, sidecar follow) is already covered by SameFileTests /
// RelocateCollisionTests / RelocateSidecarFollowTests against the shared
// LocalFileOperations primitive this feature reuses rather than duplicates.

using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RenameLogicTests
    {
        [Theory]
        [InlineData("img_1234.cr3", "img_1234")]
        [InlineData("noext", "noext")]
        [InlineData("archive.tar.gz", "archive.tar")]
        [InlineData(".hidden", "")]
        public void Stem_StripsExtensionOnly(string fileName, string expectedStem) =>
            Assert.Equal(expectedStem, RenameLogic.Stem(fileName));

        [Theory]
        [InlineData("img.cr3", "img.cr3", false)]
        [InlineData("img.cr3", "IMG.CR3", false)] // case-only rename — not an extension change
        [InlineData("img.CR3", "img.cr3", false)] // extension casing alone doesn't count either
        [InlineData("img.cr3", "img.jpg", true)]
        [InlineData("img", "img.txt", true)]
        [InlineData("img.txt", "img", true)]
        public void ExtensionChanged_ComparesExtensionsCaseInsensitively(
            string original, string typed, bool expected) =>
            Assert.Equal(expected, RenameLogic.ExtensionChanged(original, typed));

        [Theory]
        [InlineData("img.cr3", "img.cr3", true)]
        [InlineData("img.cr3", "  img.cr3  ", true)] // surrounding whitespace from the edit field
        [InlineData("img.cr3", "IMG.cr3", false)]    // a real case-only rename — NOT a no-op
        [InlineData("img.cr3", "img2.cr3", false)]
        public void IsNoopRename_OrdinalComparisonAfterTrim(string original, string typed, bool expected) =>
            Assert.Equal(expected, RenameLogic.IsNoopRename(original, typed));
    }
}
