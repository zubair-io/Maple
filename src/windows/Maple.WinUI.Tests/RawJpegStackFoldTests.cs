// RawJpegStackFoldTests — one Browse tile per RAW+JPEG pair (#5848): the
// JPEG keeps its PhotoItem but loses its tile, and the fold follows the files
// as they come and go.

using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegStackFoldTests
    {
        private static PhotoItem Photo(string path) => new()
        {
            FilePath = path,
            FileName = path[(path.LastIndexOf('/') + 1)..],
            Format = path[(path.LastIndexOf('.') + 1)..].ToUpperInvariant(),
        };

        private static List<PhotoItem> Folder(params string[] names) =>
            names.Select(name => Photo("/shoot/" + name)).ToList();

        [Fact]
        public void APairIsOneTile_TheRawCarryingTheJpeg()
        {
            var photos = Folder("IMG_1.CR3", "IMG_1.JPG", "IMG_2.CR3", "IMG_3.jpg");

            var tiles = RawJpegStackFold.Apply(photos, stacksPairs: true);

            Assert.Equal(new[] { "IMG_1.CR3", "IMG_2.CR3", "IMG_3.jpg" }, tiles.Select(t => t.FileName));
            Assert.Same(photos[1], photos[0].StackCompanion);
            Assert.Same(photos[0], photos[1].StackPrimary);
            Assert.Equal("RAW+JPEG", photos[0].FormatBadge);
            Assert.Equal("CR3", photos[2].FormatBadge);
            Assert.Equal("JPG", photos[3].FormatBadge);
            Assert.Null(photos[2].StackCompanion);
            Assert.Null(photos[3].StackPrimary);
        }

        [Fact]
        public void WithStackingOff_EveryFileIsItsOwnTile()
        {
            var photos = Folder("IMG_1.CR3", "IMG_1.JPG");
            RawJpegStackFold.Apply(photos, stacksPairs: true);

            var tiles = RawJpegStackFold.Apply(photos, stacksPairs: false);

            Assert.Equal(2, tiles.Count);
            Assert.All(photos, photo =>
            {
                Assert.Null(photo.StackCompanion);
                Assert.Null(photo.StackPrimary);
            });
        }

        [Fact]
        public void WhenTheRawLeaves_TheJpegGetsItsTileBack()
        {
            var photos = Folder("IMG_1.CR3", "IMG_1.JPG");
            RawJpegStackFold.Apply(photos, stacksPairs: true);
            var jpeg = photos[1];
            photos.RemoveAt(0);

            var tiles = RawJpegStackFold.Apply(photos, stacksPairs: true);

            Assert.Same(jpeg, Assert.Single(tiles));
            Assert.Null(jpeg.StackPrimary);
        }

        [Fact]
        public void WhenTheJpegLeaves_TheRawLosesItsBadge()
        {
            var photos = Folder("IMG_1.CR3", "IMG_1.JPG");
            RawJpegStackFold.Apply(photos, stacksPairs: true);
            var raw = photos[0];
            photos.RemoveAt(1);

            RawJpegStackFold.Apply(photos, stacksPairs: true);

            Assert.Null(raw.StackCompanion);
            Assert.Equal("CR3", raw.FormatBadge);
        }

        [Fact]
        public void ASecondJpegOnTheStem_UnfoldsThePair()
        {
            var photos = Folder("IMG_1.CR3", "IMG_1.JPG");
            RawJpegStackFold.Apply(photos, stacksPairs: true);
            photos.Add(Photo("/shoot/IMG_1.jpeg"));

            var tiles = RawJpegStackFold.Apply(photos, stacksPairs: true);

            Assert.Equal(3, tiles.Count);
            Assert.Null(photos[0].StackCompanion);
        }

        [Fact]
        public void TheBadgeChangeIsAnnounced()
        {
            var photos = Folder("IMG_1.CR3", "IMG_1.JPG");
            var changed = new List<string?>();
            photos[0].PropertyChanged += (_, e) => changed.Add(e.PropertyName);

            RawJpegStackFold.Apply(photos, stacksPairs: true);

            Assert.Contains(nameof(PhotoItem.FormatBadge), changed);
        }

        [Fact]
        public void AnActionOnATileReachesTheFoldedJpeg()
        {
            var photos = Folder("IMG_1.CR3", "IMG_1.JPG", "IMG_2.CR3");
            var tiles = RawJpegStackFold.Apply(photos, stacksPairs: true);

            Assert.Equal(photos, RawJpegStackFold.WithCompanions(tiles));
            Assert.Same(photos[0], RawJpegStackFold.TileOf(photos[1]));
            Assert.Same(photos[2], RawJpegStackFold.TileOf(photos[2]));
            Assert.Equal(tiles, RawJpegStackFold.Tiles(photos));
        }

        [Fact]
        public void TheTileFooterShowsOnlyForARatingOrARename()
        {
            var photo = Photo("/shoot/IMG_1.CR3");
            Assert.False(photo.ShowsTileFooter);

            photo.Rating = 3;
            Assert.True(photo.ShowsTileFooter);

            photo.Rating = 0;
            photo.IsRenaming = true;
            Assert.True(photo.ShowsTileFooter);
        }

        [Fact]
        public void ATilesAccessibleName_NamesBothFilesOfAStack_AndOnlyTheFileOtherwise()
        {
            var photos = Folder("IMG_1.CR3", "IMG_1.JPG", "IMG_2.CR3");

            RawJpegStackFold.Apply(photos, stacksPairs: true);

            Assert.Equal("IMG_1.CR3 and IMG_1.JPG", photos[0].TileAccessibleName);
            Assert.Equal("IMG_2.CR3", photos[2].TileAccessibleName);
        }

        [Fact]
        public void ATilesAccessibleName_FollowsAFoldChangeAndARename()
        {
            var photos = Folder("IMG_1.CR3", "IMG_1.JPG");
            var changed = new List<string?>();
            photos[0].PropertyChanged += (_, e) => changed.Add(e.PropertyName);

            RawJpegStackFold.Apply(photos, stacksPairs: true);
            photos[0].FileName = "Trip.CR3";
            photos[1].FileName = "Trip.JPG";
            photos[0].RefreshTileAccessibleName();

            Assert.Contains(nameof(PhotoItem.TileAccessibleName), changed);
            Assert.Equal("Trip.CR3 and Trip.JPG", photos[0].TileAccessibleName);

            RawJpegStackFold.Apply(photos, stacksPairs: false);
            Assert.Equal("Trip.CR3", photos[0].TileAccessibleName);
        }

        private static PhotoItem CloudPhoto(string name) =>
            new() { FilePath = "/shoot/" + name, FileName = name, Format = name[(name.LastIndexOf('.') + 1)..].ToUpperInvariant(), CloudAddress = "lib:" + name };

        [Fact]
        public void AJpegUnfoldedByAFormatFilter_NeedsItsThumbnailAndIsAskedForOnce()
        {
            var photos = new List<PhotoItem> { CloudPhoto("IMG_1.CR3"), CloudPhoto("IMG_1.JPG") };
            var requested = new HashSet<PhotoItem>();

            var atLoad = RawJpegStackFold.NeedingCloudThumbnails(RawJpegStackFold.Apply(photos, stacksPairs: true), requested);
            var afterJpgFilter = RawJpegStackFold.NeedingCloudThumbnails(RawJpegStackFold.Apply(photos, stacksPairs: false), requested);
            var again = RawJpegStackFold.NeedingCloudThumbnails(RawJpegStackFold.Apply(photos, stacksPairs: false), requested);

            Assert.Equal(new[] { "IMG_1.CR3" }, atLoad.Select(p => p.FileName));
            Assert.Equal(new[] { "IMG_1.JPG" }, afterJpgFilter.Select(p => p.FileName));
            Assert.Empty(again);
        }

        [Fact]
        public void ATileThatAlreadyHasAThumbnail_OrNoCloudAddress_NeedsNoRequest()
        {
            var withThumb = CloudPhoto("A.CR3");
            withThumb.ThumbnailPath = "file:///a.jpg";
            var local = Photo("/shoot/B.CR3");

            Assert.Empty(RawJpegStackFold.NeedingCloudThumbnails(new[] { withThumb, local }, new HashSet<PhotoItem>()));
        }

        [Fact]
        public void ATileHiddenByAFilterAtLoad_IsRequestedWhenTheFilterIsCleared_AndEachKeystrokeOnlyAsksForNewTiles()
        {
            var tiles = new[] { CloudPhoto("A.CR3"), CloudPhoto("B.CR3"), CloudPhoto("C.CR3") };
            var requested = new HashSet<PhotoItem>();

            var searchedA = RawJpegStackFold.NeedingCloudThumbnails(tiles.Where(t => t.FileName.StartsWith("A")), requested);
            var searchedAgain = RawJpegStackFold.NeedingCloudThumbnails(tiles.Where(t => t.FileName.StartsWith("A")), requested);
            var cleared = RawJpegStackFold.NeedingCloudThumbnails(tiles, requested);

            Assert.Equal(new[] { "A.CR3" }, searchedA.Select(t => t.FileName));
            Assert.Empty(searchedAgain);
            Assert.Equal(new[] { "B.CR3", "C.CR3" }, cleared.Select(t => t.FileName));
        }
    }
}
