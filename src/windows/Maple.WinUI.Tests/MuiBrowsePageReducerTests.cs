// MuiBrowsePageReducerTests — the sidebar-folder + map-cluster + timeline
// recency filter chain behind the Maple.UI Browse page (Windows Pages
// wave, #3012). No WinUI/live Window involved.

using System;
using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiBrowsePageReducerTests
    {
        [Fact]
        public void VisibleAssetIds_NullFolder_ReturnsEveryAsset()
        {
            var ids = MuiBrowsePageReducer.VisibleAssetIds(MuiPageMockLibrary.Assets, null, null);
            Assert.Equal(MuiPageMockLibrary.Assets.Count, ids.Count);
        }

        [Fact]
        public void VisibleAssetIds_LeafFolder_ReturnsOnlyThatFolder()
        {
            var ids = MuiBrowsePageReducer.VisibleAssetIds(MuiPageMockLibrary.Assets, "wedding-ceremony", null);
            Assert.All(ids, id => Assert.Equal("wedding-ceremony", MuiPageMockLibrary.Assets.First(a => a.Id == id).FolderId));
            Assert.NotEmpty(ids);
        }

        [Fact]
        public void VisibleAssetIds_ParentFolder_IncludesChildFolders()
        {
            var ids = MuiBrowsePageReducer.VisibleAssetIds(MuiPageMockLibrary.Assets, "wedding", null);
            var expected = MuiPageMockLibrary.Assets.Count(a => a.FolderId.StartsWith("wedding"));
            Assert.Equal(expected, ids.Count);
        }

        [Fact]
        public void VisibleAssetIds_MapSelection_IntersectsFolderFilter()
        {
            var oneIcelandId = MuiPageMockLibrary.Assets.First(a => a.FolderId == "iceland").Id;
            var ids = MuiBrowsePageReducer.VisibleAssetIds(MuiPageMockLibrary.Assets, "iceland", new[] { oneIcelandId });
            Assert.Equal(new[] { oneIcelandId }, ids);
        }

        [Fact]
        public void VisibleAssetIds_MapSelectionOutsideFolder_ReturnsEmpty()
        {
            var weddingId = MuiPageMockLibrary.Assets.First(a => a.FolderId == "wedding-ceremony").Id;
            var ids = MuiBrowsePageReducer.VisibleAssetIds(MuiPageMockLibrary.Assets, "iceland", new[] { weddingId });
            Assert.Empty(ids);
        }

        [Fact]
        public void ApplyRecency_AllRange_PassesEverythingThrough()
        {
            var ids = MuiPageMockLibrary.Assets.Select(a => a.Id).ToList();
            var result = MuiBrowsePageReducer.ApplyRecency(ids, MuiPageMockLibrary.Assets, "all", new DateOnly(2026, 8, 22));
            Assert.Equal(ids, result);
        }

        [Fact]
        public void ApplyRecency_RecentRange_DropsOlderThan14Days()
        {
            // 2026-07-10 puts the Iceland shoot (07-03..07-06) inside the
            // window and both the wedding (06-12) and studio (05-20)
            // shoots outside it — a real split, not an all-or-nothing one.
            var ids = MuiPageMockLibrary.Assets.Select(a => a.Id).ToList();
            var today = new DateOnly(2026, 7, 10);
            var result = MuiBrowsePageReducer.ApplyRecency(ids, MuiPageMockLibrary.Assets, "recent", today);

            var expected = MuiPageMockLibrary.Assets.Where(a => a.CapturedOn >= today.AddDays(-14)).Select(a => a.Id).ToList();
            Assert.Equal(expected.Count, result.Count);
            Assert.True(result.Count > 0 && result.Count < ids.Count);
        }
    }
}
