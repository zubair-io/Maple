// RawJpegPairingTests — the RAW+JPEG stack name rule (#5050, #5848), the
// Windows twin of `src/api/src/library/raw-jpeg-stack.ts` and Apple's
// `RawJpegPairing`: exactly one RAW and exactly one `.jpg`/`.jpeg` per folder
// and stem, compared case-folded and NFC-normalised.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegPairingTests
    {
        private static IReadOnlyDictionary<string, string> Pairs(params string[] paths) =>
            RawJpegPairing.Pairs(paths);

        [Fact]
        public void OneRawAndOneJpegWithTheSameStem_Pair_KeyedByTheRaw()
        {
            var pairs = Pairs("/shoot/IMG_1.CR3", "/shoot/IMG_1.JPG", "/shoot/IMG_2.CR3");

            Assert.Equal("/shoot/IMG_1.JPG", Assert.Single(pairs).Value);
            Assert.Equal("/shoot/IMG_1.CR3", pairs.Keys.Single());
        }

        [Theory]
        [InlineData("IMG_1.dng", "img_1.jpeg")]
        [InlineData("IMG_1.NEF", "IMG_1.Jpg")]
        [InlineData("Caf\u00e9.arw", "Cafe\u0301.jpg")]
        public void StemsCompareCaseFoldedAndNfcNormalised(string raw, string jpeg)
        {
            var pairs = Pairs("/shoot/" + raw, "/shoot/" + jpeg);

            Assert.Equal("/shoot/" + jpeg, pairs["/shoot/" + raw]);
        }

        [Fact]
        public void TwoJpegsOnOneStem_LeaveEveryMemberIndependent()
        {
            Assert.Empty(Pairs("/shoot/IMG_1.CR3", "/shoot/IMG_1.jpg", "/shoot/IMG_1.jpeg"));
        }

        [Fact]
        public void TwoRawsOnOneStem_LeaveEveryMemberIndependent()
        {
            Assert.Empty(Pairs("/shoot/IMG_1.CR3", "/shoot/IMG_1.dng", "/shoot/IMG_1.jpg"));
        }

        [Theory]
        [InlineData("IMG_1.heic")]
        [InlineData("IMG_1.tif")]
        [InlineData("IMG_1.png")]
        [InlineData("IMG_1.jpe")]
        public void OnlyJpgAndJpegAreTheJpegHalf(string other)
        {
            Assert.Empty(Pairs("/shoot/IMG_1.CR3", "/shoot/" + other));
        }

        [Fact]
        public void AJpegBesideATiff_IsNotAPair()
        {
            Assert.Empty(Pairs("/shoot/IMG_1.tif", "/shoot/IMG_1.jpg"));
        }

        [Fact]
        public void TheSameStemInDifferentFolders_DoesNotPair()
        {
            Assert.Empty(Pairs("/a/IMG_1.CR3", "/b/IMG_1.jpg"));
        }

        [Fact]
        public void AStemIsEverythingBeforeTheLastDot()
        {
            Assert.Empty(Pairs("/shoot/IMG_1.edit.CR3", "/shoot/IMG_1.jpg"));
            Assert.Single(Pairs("/shoot/IMG_1.edit.CR3", "/shoot/IMG_1.edit.jpg"));
        }

        [Fact]
        public void ADotFileHasNoExtension()
        {
            Assert.False(RawJpegPairing.IsJpeg("/shoot/.jpg"));
            Assert.False(RawJpegPairing.IsRaw("/shoot/.dng"));
        }

        [Fact]
        public void ANameThatIsNotValidUnicode_StillPairsWithoutThrowing()
        {
            var pairs = Pairs("/shoot/IMG\uD800.CR3", "/shoot/img\uD800.jpg");

            Assert.Equal("/shoot/img\uD800.jpg", pairs["/shoot/IMG\uD800.CR3"]);
        }

        [Fact]
        public void WindowsAndServerPathsPairAlike()
        {
            var pairs = Pairs(@"C:\shoot\IMG_1.CR3", @"C:\shoot\IMG_1.JPG", @"C:\other\IMG_1.jpg");

            Assert.Equal(@"C:\shoot\IMG_1.JPG", pairs[@"C:\shoot\IMG_1.CR3"]);
        }

        [Theory]
        [InlineData("IMG_1.JPG", "IMG_1.CR3", "Trip.CR3", "Trip.JPG")]
        [InlineData("img_1.jpeg", "IMG_1.CR3", "IMG_1.1.CR3", "IMG_1.1.jpeg")]
        [InlineData("img_1.jpg", "IMG_1.CR3", "IMG_1.CR3", "img_1.jpg")]
        [InlineData("img_1.jpg", "IMG_1.CR3", "IMG_1.DNG", "img_1.jpg")]
        public void TheJpegTakesTheRawsNewStemAndKeepsItsOwnExtension(
            string companion, string originalPrimary, string newPrimary, string expected)
        {
            Assert.Equal(expected, RawJpegPairing.CompanionFileName(companion, originalPrimary, newPrimary));
        }

        [Fact]
        public void RawExtensionsMatchTheServersList()
        {
            var root = RepoPaths.FindRepoRoot();
            Assert.NotNull(root);
            var body = File.ReadAllText(Path.Combine(root!, "src", "api", "src", "indexer", "media-types.ts"));
            var start = body.IndexOf("export const RAW_EXTENSIONS = new Set<string>([", StringComparison.Ordinal);
            Assert.True(start >= 0, "RAW_EXTENSIONS not found in media-types.ts");
            var block = body[start..body.IndexOf("]);", start, StringComparison.Ordinal)];
            var server = Regex.Matches(block, "'([a-z0-9]+)'").Select(match => match.Groups[1].Value).ToHashSet();

            Assert.NotEmpty(server);
            Assert.True(server.SetEquals(RawJpegPairing.RawExtensions),
                "server: " + string.Join(",", server.OrderBy(e => e))
                + " windows: " + string.Join(",", RawJpegPairing.RawExtensions.OrderBy(e => e)));
        }
    }
}
