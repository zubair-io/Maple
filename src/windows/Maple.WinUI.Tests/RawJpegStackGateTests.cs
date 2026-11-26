// RawJpegStackGateTests — when a Browse listing folds RAW+JPEG pairs (#5848):
// a local folder follows the device-local Settings switch, a Maple Cloud
// folder follows its server's flag only, and an active format filter turns
// folding off for both, as the Self Hosted server does when an extension
// filter is active (search.where.ts `extensions.length === 0`).

using System.Linq;
using System.Text.Json;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegStackGateTests
    {
        [Theory]
        [InlineData(true, true, false, false, true, false, true)]
        [InlineData(true, false, false, true, true, false, false)]
        [InlineData(false, true, true, true, true, false, true)]
        [InlineData(false, false, true, false, true, false, false)]
        [InlineData(false, false, true, true, true, false, true)]
        [InlineData(false, false, true, true, false, false, false)]
        [InlineData(true, true, true, true, false, false, true)]
        [InlineData(false, true, false, true, true, false, false)]
        [InlineData(true, true, false, false, true, true, false)]
        [InlineData(false, true, true, true, true, true, false)]
        public void FoldsWhenTheFolderKindsSwitchIsOnAndNoFormatFilterIsActive(
            bool localFolder, bool localSwitch, bool cloudFolder, bool serverFlag, bool listingComplete,
            bool formatFilter, bool expected) =>
            Assert.Equal(
                expected,
                RawJpegStackFold.ShouldFold(localFolder, localSwitch, cloudFolder, serverFlag, listingComplete, formatFilter));

        [Theory]
        [InlineData(false, false, false, null, true)]
        [InlineData(false, false, false, "", true)]
        [InlineData(true, false, false, null, false)]
        [InlineData(false, true, false, null, false)]
        [InlineData(false, false, true, null, false)]
        [InlineData(false, false, false, "next-page", false)]
        public void ACloudListingIsCompleteOnlyWhenEveryPageArrivedUncut(
            bool hitCap, bool pageFailed, bool cancelled, string? nextCursor, bool expected) =>
            Assert.Equal(expected, RawJpegStackFold.IsCloudListingComplete(hitCap, pageFailed, cancelled, nextCursor));

        [Fact]
        public void ACloudFolderFoldsOnlyOnceItsLastPageArrived()
        {
            var photos = new[]
            {
                new PhotoItem { FilePath = "/c/IMG.CR3", FileName = "IMG.CR3", Format = "CR3", CloudAddress = "a" },
                new PhotoItem { FilePath = "/c/IMG.JPG", FileName = "IMG.JPG", Format = "JPG", CloudAddress = "b" },
            };
            bool Folds(bool hitCap, bool failed, string? cursor) => RawJpegStackFold.ShouldFold(
                false, true, true, true, RawJpegStackFold.IsCloudListingComplete(hitCap, failed, false, cursor), false);

            var capped = RawJpegStackFold.Apply(photos, Folds(hitCap: true, failed: false, cursor: "more"));
            var secondPageFailed = RawJpegStackFold.Apply(photos, Folds(false, true, "more"));
            var midListing = RawJpegStackFold.Apply(photos, Folds(false, false, "page-2"));
            var lastPage = RawJpegStackFold.Apply(photos, Folds(false, false, null));

            Assert.Equal(2, capped.Count);
            Assert.Equal(2, secondPageFailed.Count);
            Assert.Equal(2, midListing.Count);
            Assert.Single(lastPage);
        }

        [Theory]
        [InlineData("All", false)]
        [InlineData("JPG", true)]
        [InlineData("CR3", true)]
        public void OnlyAFormatOtherThanAllCountsAsAnActiveFormatFilter(string format, bool active) =>
            Assert.Equal(active, RawJpegStackFold.IsFormatFilterActive(format));

        [Fact]
        public void TheLocalSwitchDefaultsToOn_AlsoForASettingsFileWrittenBeforeItExisted()
        {
            Assert.True(new AppSettings().ShowRawJpegStacks);
            Assert.True(JsonSerializer.Deserialize<AppSettings>("{\"BrowseSort\":\"Name\"}")!.ShowRawJpegStacks);
            Assert.False(JsonSerializer.Deserialize<AppSettings>("{\"ShowRawJpegStacks\":false}")!.ShowRawJpegStacks);
        }

        [Fact]
        public void WithTheLocalSwitchOff_EveryFileKeepsItsOwnTileAndNoLinkRemains()
        {
            var photos = new[]
            {
                new PhotoItem { FilePath = "/shoot/IMG_1.CR3", FileName = "IMG_1.CR3", Format = "CR3" },
                new PhotoItem { FilePath = "/shoot/IMG_1.JPG", FileName = "IMG_1.JPG", Format = "JPG" },
            };
            RawJpegStackFold.Apply(photos, RawJpegStackFold.ShouldFold(true, true, false, false, false, false));
            Assert.NotNull(photos[0].StackCompanion);

            var tiles = RawJpegStackFold.Apply(photos, RawJpegStackFold.ShouldFold(true, false, false, false, false, false));

            Assert.Equal(2, tiles.Count);
            Assert.All(photos, photo => Assert.Null(photo.StackCompanion));
            Assert.All(photos, photo => Assert.Null(photo.StackPrimary));
            Assert.Equal(new[] { "CR3", "JPG" }, photos.Select(photo => photo.FormatBadge));
        }
    }
}
