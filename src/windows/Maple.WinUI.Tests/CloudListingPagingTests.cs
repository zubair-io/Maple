// The guards that keep a cursor-paged folder walk finite and duplicate-free
// (#6104), and the name order folder tiles take as pages arrive.

using System;
using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class CloudListingPagingTests
    {
        private static List<string> Arrive(params string[][] pages)
        {
            var tiles = new List<string>();
            foreach (var name in pages.SelectMany(page => page))
                tiles.Insert(CloudListingPaging.InsertIndex(tiles, tile => tile, name), name);
            return tiles;
        }

        [Fact]
        public void Tiles_AreOrderedIgnoringCase_NotByCodeUnit()
        {
            Assert.Equal(new[] { "alpha", "Bravo", "charlie", "Delta" }, Arrive(new[] { "Delta", "charlie", "Bravo", "alpha" }));
        }

        [Fact]
        public void Tiles_ArrivingOutOfOrderAcrossTwoPages_EndUpSortedAcrossBoth()
        {
            Assert.Equal(
                new[] { "2019", "2021", "Archive", "misc", "Zed" },
                Arrive(new[] { "misc", "Zed", "2021" }, new[] { "Archive", "2019" }));
        }

        [Fact]
        public void Tiles_DifferingOnlyInCase_KeepArrivalOrder()
        {
            Assert.Equal(new[] { "Trip", "trip", "TRIP" }, Arrive(new[] { "Trip" }, new[] { "trip", "TRIP" }));
        }

        [Fact]
        public void InsertIndex_OnAnEmptyListIsZero()
        {
            Assert.Equal(0, CloudListingPaging.InsertIndex(new List<string>(), t => t, "a"));
        }

        [Fact]
        public void ARepeatedCursorIsRefused_AndEndsTheListingAsIncomplete()
        {
            var paging = new CloudListingPaging();
            Assert.True(paging.AcceptCursor("c1"));
            Assert.True(paging.AcceptCursor("c2"));
            var repeated = !paging.AcceptCursor("c1");
            Assert.True(repeated);
            Assert.False(RawJpegStackFold.IsCloudListingComplete(false, pageFailed: repeated, false, null));
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        public void NoCursorIsAlwaysAccepted(string? cursor)
        {
            var paging = new CloudListingPaging();
            Assert.True(paging.AcceptCursor(cursor));
            Assert.True(paging.AcceptCursor(cursor));
        }

        [Fact]
        public void AnAddressAlreadyListedIsNotAddedTwice()
        {
            var paging = new CloudListingPaging();
            Assert.True(paging.AcceptAddress("lib:a.dng"));
            Assert.False(paging.AcceptAddress("lib:a.dng"));
            Assert.True(paging.AcceptAddress("lib:A.dng"));
        }

        [Fact]
        public void EntriesWithoutAnAddressAreNeverTreatedAsDuplicates()
        {
            var paging = new CloudListingPaging();
            Assert.True(paging.AcceptAddress(""));
            Assert.True(paging.AcceptAddress(""));
        }
    }
}
