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
        [InlineData(true, true, false, false, false, true)]
        [InlineData(true, false, false, true, false, false)]
        [InlineData(false, true, true, true, false, true)]
        [InlineData(false, false, true, false, false, false)]
        [InlineData(false, false, true, true, false, true)]
        [InlineData(false, true, false, true, false, false)]
        [InlineData(true, true, false, false, true, false)]
        [InlineData(false, true, true, true, true, false)]
        public void FoldsWhenTheFolderKindsSwitchIsOnAndNoFormatFilterIsActive(
            bool localFolder, bool localSwitch, bool cloudFolder, bool serverFlag, bool formatFilter, bool expected) =>
            Assert.Equal(
                expected,
                RawJpegStackFold.ShouldFold(localFolder, localSwitch, cloudFolder, serverFlag, formatFilter));

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
            RawJpegStackFold.Apply(photos, RawJpegStackFold.ShouldFold(true, true, false, false, false));
            Assert.NotNull(photos[0].StackCompanion);

            var tiles = RawJpegStackFold.Apply(photos, RawJpegStackFold.ShouldFold(true, false, false, false, false));

            Assert.Equal(2, tiles.Count);
            Assert.All(photos, photo => Assert.Null(photo.StackCompanion));
            Assert.All(photos, photo => Assert.Null(photo.StackPrimary));
            Assert.Equal(new[] { "CR3", "JPG" }, photos.Select(photo => photo.FormatBadge));
        }
    }
}
