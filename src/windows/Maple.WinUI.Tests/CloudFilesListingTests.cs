// CloudFilesListingTests — a Cloud Files folder listing is committed as
// "complete" only when every page was listed (#4757). A failed, signed-out
// or truncated listing must not carry the disable-on-demand-population flag
// or a success status, or Windows records the folder as empty forever.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.CloudFiles;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class CloudFilesListingTests
    {
        private static PlaceholderEntry Entry(string name) =>
            new(name, "/" + name, false, 1, DateTime.UnixEpoch);

        private static Func<string?, Task<PlaceholderPage?>> Pages(params PlaceholderPage?[] pages)
        {
            var queue = new Queue<PlaceholderPage?>(pages);
            return _ => Task.FromResult(queue.Dequeue());
        }

        [Fact]
        public async Task EveryPageListed_IsComplete()
        {
            var listing = await CloudFilesListing.PageAllAsync(Pages(
                new PlaceholderPage(new[] { Entry("a") }, "c1"),
                new PlaceholderPage(new[] { Entry("b") }, null)));

            Assert.True(listing.Complete);
            Assert.Equal(new[] { "a", "b" }, listing.Entries.Select(e => e.Name));
        }

        [Fact]
        public async Task NullPageMidPagination_IsIncompleteAndDropsPartialEntries()
        {
            var listing = await CloudFilesListing.PageAllAsync(Pages(
                new PlaceholderPage(new[] { Entry("a") }, "c1"),
                null));

            Assert.False(listing.Complete);
            Assert.Empty(listing.Entries);
        }

        [Fact]
        public async Task ThrownFetch_IsIncomplete()
        {
            var listing = await CloudFilesListing.PageAllAsync(
                _ => throw new InvalidOperationException("network down"));

            Assert.False(listing.Complete);
            Assert.Empty(listing.Entries);
        }

        [Fact]
        public async Task CursorIsThreadedBetweenPages()
        {
            var seen = new List<string?>();
            await CloudFilesListing.PageAllAsync(cursor =>
            {
                seen.Add(cursor);
                return Task.FromResult<PlaceholderPage?>(
                    cursor == null ? new PlaceholderPage(Array.Empty<PlaceholderEntry>(), "next") : new PlaceholderPage(Array.Empty<PlaceholderEntry>(), null));
            });

            Assert.Equal(new string?[] { null, "next" }, seen);
        }

        [Fact]
        public void CompleteListing_DisablesOnDemandPopulationWithSuccess()
        {
            var completion = CloudFilesListing.Completion(CloudFilesListing.Succeeded(new[] { Entry("a") }));

            Assert.Equal(2u, completion.Flags);
            Assert.Equal(0, completion.Status);
        }

        [Fact]
        public void EmptyButCompleteListing_StillCommitsAsComplete()
        {
            var completion = CloudFilesListing.Completion(CloudFilesListing.Succeeded(Array.Empty<PlaceholderEntry>()));

            Assert.Equal(2u, completion.Flags);
            Assert.Equal(0, completion.Status);
        }

        [Fact]
        public void IncompleteListing_FailsWithoutDisablingPopulation()
        {
            var completion = CloudFilesListing.Completion(CloudFilesListing.Failed);

            Assert.Equal(0u, completion.Flags);
            Assert.Equal(unchecked((int)0xC0000001), completion.Status);
        }

        // --- Unified /api/folder/:slug/* page → placeholders (#5852) ---

        private static CloudFolderEntry Folder(string name, string address, long size = 0, string? mtime = null) =>
            new() { Name = name, Address = address, Size = size, Mtime = mtime };

        [Fact]
        public void FolderPage_MapsAllFourKindsWithAddressIdentitySizeAndMtime()
        {
            var page = CloudFilesListing.FromFolderListing(new CloudFolderListing
            {
                Folders = new[] { Folder("2024", "photos:2024", 4096, "2024-05-01T10:00:00.000Z") },
                Images = new[] { Folder("a.CR2", "photos:a.CR2", 25_000_000, "2024-05-02T11:30:00.000Z") },
                Files = new[] { Folder("clip.mov", "photos:clip.mov", 9_000) },
                Sidecars = new[] { Folder("a.xmp", "photos:a.xmp", 512) },
                NextCursor = "c2",
            });

            Assert.Equal("c2", page.NextCursor);
            Assert.Equal(new[] { "2024", "a.CR2", "clip.mov", "a.xmp" }, page.Entries.Select(e => e.Name));
            var dir = page.Entries[0];
            Assert.True(dir.IsDirectory);
            Assert.Equal(0, dir.Size);
            Assert.Equal("photos:2024", CloudFilesIdentity.ToAddress(dir.Identity, null));
            var image = page.Entries[1];
            Assert.False(image.IsDirectory);
            Assert.Equal(25_000_000, image.Size);
            Assert.Equal(new DateTime(2024, 5, 2, 11, 30, 0, DateTimeKind.Utc), image.MtimeUtc);
            Assert.Equal(DateTimeKind.Utc, image.MtimeUtc.Kind);
            Assert.Equal("photos:a.CR2", CloudFilesIdentity.ToAddress(image.Identity, null));
            Assert.All(page.Entries.Skip(1), e => Assert.False(e.IsDirectory));
        }

        [Fact]
        public void FolderPage_SkipsDotFolders()
        {
            var page = CloudFilesListing.FromFolderListing(new CloudFolderListing
            {
                Folders = new[] { Folder(".maple", "photos:.maple"), Folder("keep", "photos:keep") },
            });

            Assert.Equal("keep", Assert.Single(page.Entries).Name);
            Assert.Null(page.NextCursor);
        }

        [Fact]
        public void NamesWindowsRefuses_AreSanitizedButIdentityKeepsTheServerName()
        {
            var page = CloudFilesListing.FromFolderListing(new CloudFolderListing
            {
                Images = new[] { Folder("a:b?.jpg", "photos:a:b?.jpg", 1) },
            });

            var entry = Assert.Single(page.Entries);
            Assert.Equal("a_b_.jpg", entry.Name);
            Assert.Equal("photos:a:b?.jpg", CloudFilesIdentity.ToAddress(entry.Identity, null));
        }

        [Fact]
        public void LibraryEntry_IsADirectoryNamedByLabelAddressedByItsRoot()
        {
            var entry = CloudFilesListing.LibraryEntry(new CloudFolder { Slug = "photos", Label = "My Photos", Path = "/srv/photos" });

            Assert.Equal("My Photos", entry.Name);
            Assert.True(entry.IsDirectory);
            Assert.Equal("photos:", CloudFilesIdentity.ToAddress(entry.Identity, null));
        }
    }
}
