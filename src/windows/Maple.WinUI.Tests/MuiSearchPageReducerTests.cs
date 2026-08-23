// MuiSearchPageReducerTests — the facet-AND-query filter behind the
// Maple.UI Search page (Windows Pages wave, #3012). No WinUI/live Window
// involved.

using System;
using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiSearchPageReducerTests
    {
        [Fact]
        public void Filter_EmptyQueryNoFacets_ReturnsEveryAsset()
        {
            var ids = MuiSearchPageReducer.Filter(MuiPageMockLibrary.Assets, string.Empty, Array.Empty<string>());
            Assert.Equal(MuiPageMockLibrary.Assets.Count, ids.Count);
        }

        [Fact]
        public void Filter_QueryMatchesFilenameCaseInsensitively()
        {
            var target = MuiPageMockLibrary.Assets.First();
            var ids = MuiSearchPageReducer.Filter(MuiPageMockLibrary.Assets, target.Filename.ToLowerInvariant(), Array.Empty<string>());
            Assert.Contains(target.Id, ids);
        }

        [Fact]
        public void Filter_FacetNarrowsToSelectedFolders()
        {
            var ids = MuiSearchPageReducer.Filter(MuiPageMockLibrary.Assets, string.Empty, new[] { "iceland" });
            Assert.All(ids, id => Assert.Equal("iceland", MuiPageMockLibrary.Assets.First(a => a.Id == id).FolderId));
        }

        [Fact]
        public void Filter_FacetAndQuery_CombineWithAnd()
        {
            var icelandAsset = MuiPageMockLibrary.Assets.First(a => a.FolderId == "iceland");
            var weddingAsset = MuiPageMockLibrary.Assets.First(a => a.FolderId == "wedding-ceremony");

            // A query that only matches a wedding photo, ANDed with the
            // Iceland facet, must return nothing — the facet doesn't OR
            // in unrelated matches.
            var ids = MuiSearchPageReducer.Filter(MuiPageMockLibrary.Assets, weddingAsset.Filename, new[] { "iceland" });
            Assert.Empty(ids);
            Assert.NotEqual(icelandAsset.Filename, weddingAsset.Filename);
        }

        [Fact]
        public void Filter_NoMatches_ReturnsEmpty()
        {
            var ids = MuiSearchPageReducer.Filter(MuiPageMockLibrary.Assets, "nonexistent-file", Array.Empty<string>());
            Assert.Empty(ids);
        }
    }
}
