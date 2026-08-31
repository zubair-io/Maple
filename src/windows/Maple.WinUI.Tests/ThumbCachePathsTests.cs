// ThumbCachePathsTests — the Windows quarter of the #2254 cross-platform
// hash parity gate (#3083). Identical vectors are pinned in the three
// sibling implementations:
//   - API:   src/api/src/fs/xmp.test.ts ("sha256Prefix16 — cross-platform pinned vectors")
//   - Apple: src/apple/Packages/MapleCore/Tests/MapleCoreTests/ThumbnailDiskCacheKeyTests.swift
//   - Web:   src/web/projects/maple-common/src/lib/maple-cache/sha.spec.ts
// All four MUST agree on these exact hex strings, or `.maple/thumbs/`
// written by one layer becomes unreadable by the others.

using System.IO;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class ThumbCachePathsTests
    {
        [Theory]
        [InlineData("IMG_0001.ARW", "8fd710b39cdc1a26")]
        [InlineData("test.dng", "b9011a0233accea2")]
        [InlineData("IMG_1234.dng", "7ad25b268a071d01")]
        [InlineData("photo.HEIC", "db03400ba7adff45")]
        public void Sha256Prefix16_MatchesTheCrossPlatformPinnedVectors(string filename, string expected)
        {
            Assert.Equal(expected, ThumbCachePaths.Sha256Prefix16(filename));
        }

        [Fact]
        public void SharedThumbPathFor_HashesTheBasenameOnly_SoTheCacheTravelsWithThePhotos()
        {
            // Same basename under two different parents ⇒ same filename,
            // sibling `.maple\thumbs` dirs — copy the folder elsewhere and
            // the same key still resolves.
            var a = ThumbCachePaths.SharedThumbPathFor(Path.Combine("C:\\photos", "IMG_1234.dng"));
            var b = ThumbCachePaths.SharedThumbPathFor(Path.Combine("D:\\backup", "IMG_1234.dng"));
            Assert.Equal(
                Path.Combine("C:\\photos", ".maple", "thumbs", "7ad25b268a071d01.avif"), a);
            Assert.Equal(Path.GetFileName(a), Path.GetFileName(b));
        }

        [Fact]
        public void SharedThumbPathFor_AlwaysEmitsAvif_RegardlessOfSourceExtension()
        {
            // Every layer normalises cached thumbs to AVIF; the source
            // extension participates in the HASH (basename with extension)
            // but never in the output extension.
            var path = ThumbCachePaths.SharedThumbPathFor(Path.Combine("C:\\photos", "photo.HEIC"));
            Assert.Equal(Path.Combine("C:\\photos", ".maple", "thumbs", "db03400ba7adff45.avif"), path);
        }

        [Fact]
        public void Sha256Prefix16_IsCaseSensitive_MatchingTheOtherLayers()
        {
            // path.basename / URL.lastPathComponent are case-preserving on
            // every platform, and SHA-256 is byte-exact — a case-folding
            // Windows port would resolve different files than the API/Apple
            // for the same photo.
            Assert.NotEqual(
                ThumbCachePaths.Sha256Prefix16("IMG_0001.ARW"),
                ThumbCachePaths.Sha256Prefix16("img_0001.arw"));
        }
    }
}
