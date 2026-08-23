// MuiRemoteImageLoaderTests — the tiered thumb -> preview -> full state
// machine behind the Maple.UI Remote Image atom (Maple.WinUI/MapleUI/Atoms/
// MuiRemoteImageLoader.cs, wave 2 of the Windows Maple.UI atoms, #3012).
// Generic over TImage (here, plain strings stand in for ImageSource) so it
// has zero WinUI/WinRT dependency and every fetch is a fake in-memory
// delegate — no networking, no live Window, no real async waiting.

using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Maple.UI.Atoms;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiRemoteImageLoaderTests
    {
        private static MuiRemoteImageLoader<string> AlwaysSucceeds(List<MuiRemoteImageTier> attempts)
        {
            return new MuiRemoteImageLoader<string>((tier, _) =>
            {
                attempts.Add(tier);
                return Task.FromResult(tier.ToString());
            });
        }

        [Fact]
        public async Task Start_LoadsAllThreeTiersInOrder()
        {
            var attempts = new List<MuiRemoteImageTier>();
            var ready = new List<MuiRemoteImageTier>();
            var loader = AlwaysSucceeds(attempts);
            loader.TierReady += (tier, _) => ready.Add(tier);

            await loader.Start();

            Assert.Equal(new[] { MuiRemoteImageTier.Thumb, MuiRemoteImageTier.Preview, MuiRemoteImageTier.Full }, attempts);
            Assert.Equal(attempts, ready);
        }

        [Fact]
        public async Task Start_AllTiersSucceed_EndsInCompleteState()
        {
            var loader = AlwaysSucceeds(new List<MuiRemoteImageTier>());
            await loader.Start();
            Assert.Equal(MuiRemoteImageLoadState.Complete, loader.State);
        }

        [Fact]
        public async Task Start_ThumbFails_EndsInFailedState_AndNeverAttemptsLaterTiers()
        {
            var attempts = new List<MuiRemoteImageTier>();
            var failures = new List<MuiRemoteImageTier>();
            var loader = new MuiRemoteImageLoader<string>((tier, _) =>
            {
                attempts.Add(tier);
                return Task.FromException<string>(new InvalidOperationException("network down"));
            });
            loader.TierFailed += (tier, _) => failures.Add(tier);

            await loader.Start();

            Assert.Equal(MuiRemoteImageLoadState.Failed, loader.State);
            Assert.Equal(new[] { MuiRemoteImageTier.Thumb }, attempts);
            Assert.Equal(new[] { MuiRemoteImageTier.Thumb }, failures);
        }

        [Fact]
        public async Task Start_ThumbSucceedsThenPreviewFails_EndsInPartialState_KeepingTheThumb()
        {
            var ready = new List<MuiRemoteImageTier>();
            var loader = new MuiRemoteImageLoader<string>((tier, _) => tier == MuiRemoteImageTier.Thumb
                ? Task.FromResult("thumb-bytes")
                : Task.FromException<string>(new InvalidOperationException("preview fetch failed")));
            loader.TierReady += (tier, _) => ready.Add(tier);

            await loader.Start();

            Assert.Equal(MuiRemoteImageLoadState.Partial, loader.State);
            Assert.Equal(new[] { MuiRemoteImageTier.Thumb }, ready);
        }

        [Fact]
        public async Task Retry_AfterAHardFailure_RestartsFromTheFailedTier()
        {
            var attemptCount = 0;
            var loader = new MuiRemoteImageLoader<string>((tier, _) =>
            {
                attemptCount++;
                return attemptCount == 1
                    ? Task.FromException<string>(new InvalidOperationException("first attempt fails"))
                    : Task.FromResult("thumb-bytes");
            });

            await loader.Start();
            Assert.Equal(MuiRemoteImageLoadState.Failed, loader.State);

            await loader.Retry();
            Assert.Equal(MuiRemoteImageLoadState.Complete, loader.State);
            Assert.Equal(4, attemptCount); // failed Thumb, then Thumb/Preview/Full all succeed
        }

        [Fact]
        public async Task Retry_WithNothingEverAttempted_StartsFromThumb()
        {
            var attempts = new List<MuiRemoteImageTier>();
            var loader = AlwaysSucceeds(attempts);

            await loader.Retry();

            Assert.Equal(MuiRemoteImageTier.Thumb, attempts[0]);
        }

        [Fact]
        public void State_BeforeStart_IsIdle()
        {
            var loader = AlwaysSucceeds(new List<MuiRemoteImageTier>());
            Assert.Equal(MuiRemoteImageLoadState.Idle, loader.State);
        }
    }
}
