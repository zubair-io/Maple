// MuiPageMockLibraryTests — the folder-count rollup behind the shared
// fictional library every Windows Page composition reuses (Windows Pages
// wave, #3012). No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiPageMockLibraryTests
    {
        [Fact]
        public void CountFor_LeafFolder_CountsOnlyItsOwnAssets()
        {
            var expected = 3; // wedding-ceremony: a-4181, a-4182, a-4183
            Assert.Equal(expected, MuiPageMockLibrary.CountFor("wedding-ceremony"));
        }

        [Fact]
        public void CountFor_ParentFolder_RollsUpChildCounts()
        {
            var ceremony = MuiPageMockLibrary.CountFor("wedding-ceremony");
            var reception = MuiPageMockLibrary.CountFor("wedding-reception");
            Assert.Equal(ceremony + reception, MuiPageMockLibrary.CountFor("wedding"));
        }

        [Fact]
        public void CountFor_UnknownFolder_ReturnsZero()
        {
            Assert.Equal(0, MuiPageMockLibrary.CountFor("does-not-exist"));
        }
    }
}
