using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services
{
    internal static class LibraryHydration
    {
        public const int RenderGateWidth = 4;
        // One render slot stays free so a photo the user opens mid-fill never queues behind the fill.
        public const int Width = RenderGateWidth - 1;
        public const int BatchSize = 25;

        private static readonly SemaphoreSlim Admission = new(Width);

        private enum Outcome { Pending, Done, Failed }

        /// <summary>Batches are applied in listing order, one at a time; a photo whose work
        /// throws is skipped and reported; cancellation throws.</summary>
        public static async Task RunAsync<TItem, TResult>(
            IReadOnlyList<TItem> items,
            int width,
            int batchSize,
            Func<TItem, CancellationToken, Task<TResult>> work,
            Func<IReadOnlyList<(TItem Item, TResult Result)>, Task> applyBatch,
            Func<Task> afterLastBatch,
            Action<TItem, Exception> onItemFailed,
            CancellationToken ct)
        {
            if (items.Count == 0)
                return;
            var results = new TResult?[items.Count];
            var outcomes = new Outcome[items.Count];
            var gate = new object();
            using var signal = new SemaphoreSlim(0);
            using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);

            var workTask = Parallel.ForEachAsync(
                Indices(items.Count),
                new ParallelOptions { MaxDegreeOfParallelism = width, CancellationToken = stop.Token },
                async (index, token) =>
                {
                    var outcome = Outcome.Done;
                    await Admission.WaitAsync(token);
                    try
                    {
                        results[index] = await work(items[index], token);
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception error) when (error is not OutOfMemoryException)
                    {
                        onItemFailed(items[index], error);
                        outcome = Outcome.Failed;
                    }
                    finally
                    {
                        Admission.Release();
                    }
                    lock (gate)
                        outcomes[index] = outcome;
                    signal.Release();
                });

            try
            {
                var next = 0;
                var applied = 0;
                while (next < items.Count)
                {
                    var before = next;
                    var batch = new List<(TItem Item, TResult Result)>();
                    lock (gate)
                    {
                        while (batch.Count < batchSize && next < items.Count && outcomes[next] != Outcome.Pending)
                        {
                            if (outcomes[next] == Outcome.Done)
                                batch.Add((items[next], results[next]!));
                            next++;
                        }
                    }
                    stop.Token.ThrowIfCancellationRequested();
                    if (batch.Count > 0)
                    {
                        await applyBatch(batch);
                        applied += batch.Count;
                    }
                    else if (next == before)
                    {
                        var woke = signal.WaitAsync(stop.Token);
                        if (await Task.WhenAny(woke, workTask) == workTask)
                            await workTask;
                        else
                            await woke;
                    }
                }
                if (applied > 0)
                {
                    stop.Token.ThrowIfCancellationRequested();
                    await afterLastBatch();
                }
            }
            catch
            {
                stop.Cancel();
                try { await workTask; }
                catch (OperationCanceledException) { }
                throw;
            }
            await workTask;
        }

        public static Task RunInBackground<TItem>(
            IReadOnlyList<TItem> items,
            Func<TItem, CancellationToken, Task> step,
            Action<TItem, Exception> onItemFailed,
            CancellationToken ct) =>
            Task.Run(async () =>
            {
                foreach (var item in items)
                {
                    if (ct.IsCancellationRequested)
                        return;
                    try
                    {
                        await Admission.WaitAsync(ct);
                        try
                        {
                            await step(item, ct);
                        }
                        finally
                        {
                            Admission.Release();
                        }
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested)
                    {
                        return;
                    }
                    catch (Exception error) when (error is not OutOfMemoryException)
                    {
                        onItemFailed(item, error);
                    }
                }
            });

        private static IEnumerable<int> Indices(int count)
        {
            for (var index = 0; index < count; index++)
                yield return index;
        }
    }
}
