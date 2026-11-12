// CloudFilesIdentityTests — a Maple Cloud placeholder's FileIdentity is its
// `slug:relPath` address (#5852). Placeholders from earlier builds carry the
// absolute server path; those resolve against the library roots so folders
// Explorer already populated keep hydrating after an upgrade.

using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.CloudFiles;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class CloudFilesIdentityTests
    {
        private static readonly CloudFolder[] Libraries =
        {
            new() { Id = "a1", Slug = "photos", Path = "/srv/photos" },
            new() { Id = "a2", Slug = "photos-archive", Path = "/srv/photos/archive" },
            new() { Id = "a3", Slug = "nas", Path = @"D:\Pictures\" },
        };

        [Fact]
        public void AddressIdentity_RoundTripsWithoutConsultingLibraries()
        {
            var identity = CloudFilesIdentity.FromAddress("photos:2024/a b.CR2");

            Assert.True(CloudFilesIdentity.IsAddress(identity));
            Assert.Equal("photos:2024/a b.CR2", CloudFilesIdentity.ToAddress(identity, null));
        }

        [Fact]
        public void LibraryIdentity_IsTheLibraryRootAddress()
        {
            var identity = CloudFilesIdentity.ForLibrary(Libraries[0]);

            Assert.Equal("photos:", CloudFilesIdentity.ToAddress(identity, null));
        }

        [Fact]
        public void NoAbsolutePathLooksLikeAnAddress()
        {
            Assert.False(CloudFilesIdentity.IsAddress("/srv/photos/address:x"));
            Assert.False(CloudFilesIdentity.IsAddress(@"C:\address\x"));
            Assert.False(CloudFilesIdentity.IsAddress(@"\\nas\share\x"));
        }

        [Theory]
        [InlineData("/srv/photos", "photos:")]
        [InlineData("/srv/photos/", "photos:")]
        [InlineData("/srv/photos/2024/IMG_0001.CR2", "photos:2024/IMG_0001.CR2")]
        [InlineData("/srv/photos/archive/old.jpg", "photos-archive:old.jpg")]
        [InlineData("/srv/photos/archived/x.jpg", "photos:archived/x.jpg")]
        [InlineData(@"D:\Pictures", "nas:")]
        [InlineData(@"D:\Pictures\2024\a.NEF", "nas:2024/a.NEF")]
        public void LegacyAbsolutePath_ResolvesToTheLongestLibraryRoot(string legacy, string address)
        {
            Assert.Equal(address, CloudFilesIdentity.ToAddress(legacy, Libraries));
        }

        [Theory]
        [InlineData("/srv/photography/x.jpg")]
        [InlineData("/mnt/real/photos/x.jpg")]
        [InlineData("/SRV/photos/x.jpg")]
        public void LegacyPathOutsideEveryRoot_IsUnresolved(string legacy)
        {
            Assert.Null(CloudFilesIdentity.ToAddress(legacy, Libraries));
        }

        [Fact]
        public void LegacyPathWithoutALibraryList_IsUnresolved()
        {
            Assert.Null(CloudFilesIdentity.ToAddress("/srv/photos/x.jpg", null));
        }

        [Fact]
        public void LibraryAtFilesystemRoot_ClaimsEverythingBelowIt()
        {
            var root = new[] { new CloudFolder { Slug = "all", Path = "/" } };

            Assert.Equal("all:", CloudFilesIdentity.ToAddress("/", root));
            Assert.Equal("all:srv/x.jpg", CloudFilesIdentity.ToAddress("/srv/x.jpg", root));
        }
    }
}
