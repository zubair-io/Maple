// MuiTvTimelinePageReducerTests — the shared range filter feeding both
// the Timeline and Collection Grid tabs of the Maple.UI TV Timeline page
// (Windows Pages wave, #3012). No WinUI/live Window involved.

using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiTvTimelinePageReducerTests
    {
        [Fact]
        public void AssetIdsForRange_All_ReturnsEveryAsset()
        {
            var ids = MuiTvTimelinePageReducer.AssetIdsForRange(MuiPageMockLibrary.Assets, "all");
            Assert.Equal(MuiPageMockLibrary.Assets.Count, ids.Count);
        }

        [Fact]
        public void AssetIdsForRange_Iceland_ReturnsOnlyIcelandAssets()
        {
            var ids = MuiTvTimelinePageReducer.AssetIdsForRange(MuiPageMockLibrary.Assets, "iceland");
            Assert.All(ids, id => Assert.Equal("iceland", MuiPageMockLibrary.Assets.First(a => a.Id == id).FolderId));
            Assert.NotEmpty(ids);
        }

        [Fact]
        public void AssetIdsForRange_Wedding_IncludesBothCeremonyAndReception()
        {
            var ids = MuiTvTimelinePageReducer.AssetIdsForRange(MuiPageMockLibrary.Assets, "wedding");
            Assert.Contains(ids, id => MuiPageMockLibrary.Assets.First(a => a.Id == id).FolderId == "wedding-ceremony");
            Assert.Contains(ids, id => MuiPageMockLibrary.Assets.First(a => a.Id == id).FolderId == "wedding-reception");
        }

        [Fact]
        public void AssetIdsForRange_Studio_ReturnsOnlyStudioAssets()
        {
            var ids = MuiTvTimelinePageReducer.AssetIdsForRange(MuiPageMockLibrary.Assets, "studio");
            Assert.All(ids, id => Assert.Equal("studio", MuiPageMockLibrary.Assets.First(a => a.Id == id).FolderId));
            Assert.NotEmpty(ids);
        }
    }
}
