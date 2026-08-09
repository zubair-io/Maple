// RevealInFileManagerLogicTests — eligibility filtering, target selection,
// and argument-building behind "Show in Explorer" (#2658).

using System.Collections.Generic;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RevealInFileManagerLogicTests
    {
        [Fact]
        public void IsEligible_LocalOrSmb_True()
        {
            Assert.True(RevealInFileManagerLogic.IsEligible(isCloud: false));
        }

        [Fact]
        public void IsEligible_Cloud_False()
        {
            Assert.False(RevealInFileManagerLogic.IsEligible(isCloud: true));
        }

        [Fact]
        public void EligiblePaths_FiltersOutCloud_PreservesOrder()
        {
            var items = new[]
            {
                (FilePath: @"C:\Library\a.dng", IsCloud: false),
                (FilePath: @"srv:photos/b.dng", IsCloud: true),
                (FilePath: @"\\nas\share\c.dng", IsCloud: false),
            };

            var eligible = RevealInFileManagerLogic.EligiblePaths(items);

            Assert.Equal(new[] { @"C:\Library\a.dng", @"\\nas\share\c.dng" }, eligible);
        }

        [Fact]
        public void EligiblePaths_AllCloud_Empty()
        {
            var items = new[]
            {
                (FilePath: "srv:photos/a.dng", IsCloud: true),
                (FilePath: "srv:photos/b.dng", IsCloud: true),
            };

            Assert.Empty(RevealInFileManagerLogic.EligiblePaths(items));
        }

        [Fact]
        public void RevealTarget_MixedSelection_ReturnsFirstEligible()
        {
            var items = new[]
            {
                (FilePath: "srv:photos/a.dng", IsCloud: true),
                (FilePath: @"C:\Library\b.dng", IsCloud: false),
                (FilePath: @"C:\Library\c.dng", IsCloud: false),
            };

            Assert.Equal(@"C:\Library\b.dng", RevealInFileManagerLogic.RevealTarget(items));
        }

        [Fact]
        public void RevealTarget_NothingEligible_ReturnsNull()
        {
            var items = new[] { (FilePath: "srv:photos/a.dng", IsCloud: true) };

            Assert.Null(RevealInFileManagerLogic.RevealTarget(items));
        }

        [Fact]
        public void RevealTarget_EmptySelection_ReturnsNull()
        {
            Assert.Null(RevealInFileManagerLogic.RevealTarget(System.Array.Empty<(string, bool)>()));
        }

        // The quotes around the path are load-bearing for two separate reasons,
        // both locked in below:
        //   1. explorer.exe splits its own command line on the first comma
        //      after "/select" — without quotes, a path containing a comma
        //      (a legal Windows filename character) would be truncated at
        //      that comma instead of treated as part of the path. Quoting the
        //      field is what lets explorer.exe's parser see the whole path,
        //      comma included, as one unit.
        //   2. A trailing backslash immediately before the closing quote is
        //      an escape sequence under Win32's CommandLineToArgvW (which
        //      every Windows process, including explorer.exe, uses to split
        //      ITS OWN argv): an odd run of backslashes before a `"` escapes
        //      the quote rather than closing the string, so an untrimmed
        //      `E:\` would leave the argument unterminated. SelectArgument
        //      trims the trailing separator before quoting to sidestep that
        //      — EXCEPT for a bare drive root (see the next case), where
        //      trimming to `"E:"` would be quoted correctly but semantically
        //      wrong: `E:` alone is drive-RELATIVE in Win32, not the root,
        //      so that case is emitted unquoted with the backslash kept
        //      instead (`E:\` can't contain a space or comma, so it never
        //      needed quoting to begin with).
        [Theory]
        [InlineData(@"C:\Library\Vacation\photo.dng", "/select,\"C:\\Library\\Vacation\\photo.dng\"")]
        [InlineData(@"\\nas\share\photo.dng", "/select,\"\\\\nas\\share\\photo.dng\"")]
        [InlineData(@"C:\My, Photos\a b.dng", "/select,\"C:\\My, Photos\\a b.dng\"")]
        [InlineData(@"\\nas\My Share\a b.dng", "/select,\"\\\\nas\\My Share\\a b.dng\"")]
        [InlineData(@"E:\", "/select,E:\\")]
        [InlineData(@"E:", "/select,E:\\")]
        [InlineData(@"C:\Library\", "/select,\"C:\\Library\"")]
        public void SelectArgument_QuotesRawPath(string path, string expected)
        {
            Assert.Equal(expected, RevealInFileManagerLogic.SelectArgument(path));
        }
    }
}
