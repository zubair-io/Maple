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

        [Theory]
        [InlineData(@"C:\Library\Vacation\photo.dng", "/select,\"C:\\Library\\Vacation\\photo.dng\"")]
        [InlineData(@"\\nas\share\photo.dng", "/select,\"\\\\nas\\share\\photo.dng\"")]
        public void SelectArgument_QuotesRawPath(string path, string expected)
        {
            Assert.Equal(expected, RevealInFileManagerLogic.SelectArgument(path));
        }
    }
}
