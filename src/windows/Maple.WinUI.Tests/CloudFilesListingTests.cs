// CloudFilesListingTests — a Cloud Files folder listing is committed as
// "complete" only when every page was listed (#4757). A failed, signed-out
// or truncated listing must not carry the disable-on-demand-population flag
// or a success status, or Windows records the folder as empty forever.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
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
        public async Task StreamPages_TransfersEachPageBeforeFetchingTheNext()
        {
            var calls = new List<string>();
            var result = await CloudFilesListing.StreamPagesAsync(cursor =>
            {
                calls.Add($"fetch:{cursor ?? "first"}");
                return Task.FromResult<PlaceholderPage?>(cursor == null
                    ? new PlaceholderPage(new[] { Entry("a") }, "next")
                    : new PlaceholderPage(new[] { Entry("b") }, null));
            }, (entries, totalCount) =>
            {
                calls.Add($"transfer:{entries[0].Name}:{totalCount}");
                return true;
            });

            Assert.True(result.Complete);
            Assert.Equal(2, result.TransferredCount);
            Assert.Equal(new[]
            {
                "fetch:first", "transfer:a:1", "fetch:next", "transfer:b:2",
            }, calls);
        }

        [Fact]
        public async Task StreamPages_FailedLaterPageKeepsEarlierPageRetryable()
        {
            var transferred = new List<string>();
            var result = await CloudFilesListing.StreamPagesAsync(cursor =>
                Task.FromResult<PlaceholderPage?>(cursor == null
                    ? new PlaceholderPage(new[] { Entry("a") }, "next")
                    : null), (entries, _) =>
            {
                transferred.AddRange(entries.Select(e => e.Name));
                return true;
            });

            Assert.False(result.Complete);
            Assert.Equal(1, result.TransferredCount);
            Assert.Equal(new[] { "a" }, transferred);
        }

        [Fact]
        public void NameCollision_IsDisambiguatedWithoutChangingServerIdentity()
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var entries = new[]
            {
                new PlaceholderEntry("IMG.JPG", "folder:IMG.JPG", false, 1, DateTime.UnixEpoch),
                new PlaceholderEntry("img.jpg", "folder:img.jpg", false, 1, DateTime.UnixEpoch),
            };

            var unique = CloudFilesListing.WithUniqueWindowsNames(entries, names);

            Assert.Equal("IMG.JPG", unique[0].Name);
            Assert.StartsWith("img (", unique[1].Name);
            Assert.EndsWith(").jpg", unique[1].Name, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(new[] { "folder:IMG.JPG", "folder:img.jpg" }, unique.Select(e => e.Address));
            Assert.Equal(2, names.Count);
        }

        [Fact]
        public void PopulationPolicyFull_IsTheDocumentedValue()
        {
            Assert.Equal((ushort)2, CfApi.CF_POPULATION_POLICY_FULL);
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
    }
}
