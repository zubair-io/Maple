using System;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.UI.Atoms
{
    /// <summary>Which rung of the thumb -> preview -> full ladder a Remote
    /// Image tier represents (docs/unified-component-catalog.md §1.4,
    /// Remote Image row: "Tiers: thumb -> preview -> full").</summary>
    public enum MuiRemoteImageTier { Thumb, Preview, Full }

    /// <summary>Overall load state exposed to the WinUI-side control.</summary>
    public enum MuiRemoteImageLoadState
    {
        /// <summary>Nothing requested yet.</summary>
        Idle,
        /// <summary>A tier fetch is in flight and nothing has rendered yet.</summary>
        Loading,
        /// <summary>At least one tier rendered but Full hasn't landed yet.</summary>
        Partial,
        /// <summary>Full landed — the ladder is complete.</summary>
        Complete,
        /// <summary>The very first attempted tier failed and nothing has
        /// ever rendered — a hard failure the host should show a retry
        /// affordance for.</summary>
        Failed,
    }

    /// <summary>
    /// Plain, WinUI-free state machine behind the Maple.UI Remote Image atom
    /// (docs/unified-component-catalog.md §1.4 "Remote Image" row — an
    /// authenticated, cached, tiered load with a blur-up transition and a
    /// retry affordance). Deliberately generic over HOW a tier's bytes get
    /// fetched: the WinUI control supplies one async loader delegate per
    /// tier, and this class owns only the sequencing/retry/failure
    /// bookkeeping — no networking, no caching, no WinUI/WinRT dependency —
    /// so it links into Maple.WinUI.Tests (net8.0, no WinUI) the same way
    /// MuiTimestampFormatter.cs does, and is the one part of this atom CI
    /// can actually exercise without a live Window.
    ///
    /// Sequencing: Thumb starts immediately on <see cref="Start"/>; each
    /// successful tier immediately kicks off the next one (the "blur-up"
    /// ladder — MuiRemoteImage crossfades to each new tier as it lands). A
    /// failure on Thumb with nothing ever having rendered is a hard
    /// <see cref="MuiRemoteImageLoadState.Failed"/> — the caller has nothing
    /// to show yet. A failure on Preview or Full after an earlier tier
    /// already rendered is a soft failure: the last good tier stays
    /// displayed (state stays <see cref="MuiRemoteImageLoadState.Partial"/>)
    /// and <see cref="TierFailed"/> fires so the host can offer a
    /// "load full-res" retry without losing the thumb that's already up.
    /// </summary>
    public sealed class MuiRemoteImageLoader<TImage>
    {
        private static readonly MuiRemoteImageTier[] Ladder =
            { MuiRemoteImageTier.Thumb, MuiRemoteImageTier.Preview, MuiRemoteImageTier.Full };

        private readonly Func<MuiRemoteImageTier, CancellationToken, Task<TImage>> _load;
        private CancellationTokenSource? _cts;
        private int _nextIndex;
        private MuiRemoteImageTier? _lastAttempted;
        private bool _everSucceeded;

        public MuiRemoteImageLoadState State { get; private set; } = MuiRemoteImageLoadState.Idle;

        /// <summary>Fires each time a tier's image lands, in ladder order.</summary>
        public event Action<MuiRemoteImageTier, TImage>? TierReady;

        /// <summary>Fires when a tier's fetch throws — see the class summary
        /// for hard-vs-soft failure handling.</summary>
        public event Action<MuiRemoteImageTier, Exception>? TierFailed;

        public MuiRemoteImageLoader(Func<MuiRemoteImageTier, CancellationToken, Task<TImage>> load)
        {
            _load = load ?? throw new ArgumentNullException(nameof(load));
        }

        /// <summary>Begins (or restarts) the ladder from Thumb.</summary>
        public Task Start()
        {
            _nextIndex = 0;
            _everSucceeded = false;
            return RunAsync();
        }

        /// <summary>Retries the most recently attempted tier (the one that
        /// failed), or starts from Thumb if nothing has ever been
        /// attempted.</summary>
        public Task Retry()
        {
            _nextIndex = _lastAttempted is { } tier ? Array.IndexOf(Ladder, tier) : 0;
            return RunAsync();
        }

        /// <summary>Cancels any in-flight fetch without changing State — for
        /// a host tearing down (e.g. the image scrolled out of view).</summary>
        public void Cancel()
        {
            _cts?.Cancel();
            _cts = null;
        }

        private async Task RunAsync()
        {
            while (_nextIndex < Ladder.Length)
            {
                var tier = Ladder[_nextIndex];
                _lastAttempted = tier;
                State = MuiRemoteImageLoadState.Loading;

                _cts?.Cancel();
                var cts = new CancellationTokenSource();
                _cts = cts;

                TImage image;
                try
                {
                    image = await _load(tier, cts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (Exception ex)
                {
                    State = _everSucceeded ? MuiRemoteImageLoadState.Partial : MuiRemoteImageLoadState.Failed;
                    TierFailed?.Invoke(tier, ex);
                    return;
                }

                _everSucceeded = true;
                _nextIndex++;
                State = tier == MuiRemoteImageTier.Full
                    ? MuiRemoteImageLoadState.Complete
                    : MuiRemoteImageLoadState.Partial;
                TierReady?.Invoke(tier, image);
            }
        }
    }
}
