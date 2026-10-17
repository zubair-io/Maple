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

        [Fact]
        public void SynchronousThrowBeforeTheTaskStarts_IsIncomplete()
        {
            var listing = CloudFilesListing.ListOrFail(() => throw new InvalidOperationException("bad identity"));

            Assert.False(listing.Complete);
        }

        [Fact]
        public void FaultedTask_IsIncomplete()
        {
            var listing = CloudFilesListing.ListOrFail(() => Task.FromException<PlaceholderListing>(new InvalidOperationException("boom")));

            Assert.False(listing.Complete);
        }
    }
}
