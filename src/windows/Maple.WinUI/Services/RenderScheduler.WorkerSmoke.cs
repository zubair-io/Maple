using System;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    // #4383: isolated lifecycle process only. A queued render must complete
    // while the shared pool has no admission capacity. Do not use the UI
    // present path here: this deliberately holds the UI thread for the oracle.
    private static async Task VerifyWorkerAdmissionAsync(DecodedImage image, AdjustmentState state)
    {
        ThreadPool.GetMinThreads(out var minWorkers, out var minIo);
        ThreadPool.GetMaxThreads(out var maxWorkers, out var maxIo);
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var rendered = new ManualResetEventSlim();
        RenderScheduler? scheduler = null;
        Task? blocker = null;
        var completedUnderPressure = false;
        try
        {
            if (!ThreadPool.SetMinThreads(1, minIo) || !ThreadPool.SetMaxThreads(1, maxIo))
                throw new InvalidOperationException("Cannot constrain isolated worker-pool admission");
            blocker = Task.Run(() =>
            {
                entered.Set();
                if (!release.Wait(TimeSpan.FromSeconds(10)))
                    throw new TimeoutException("Worker admission oracle was not released");
            });
            if (!entered.Wait(TimeSpan.FromSeconds(5)))
                throw new TimeoutException("Worker admission oracle did not start");
            // Construct after admission is exhausted. A Task.Run render loop
            // cannot start until the blocker is released; the dedicated loop can.
            scheduler = new RenderScheduler();
            scheduler.FrameReady += (_, _, _, _, _, _) => rendered.Set();
            scheduler.SetImage(image);
            scheduler.RequestRender(state.Clone());
            completedUnderPressure = rendered.Wait(TimeSpan.FromSeconds(3));
        }
        finally
        {
            release.Set();
            ThreadPool.SetMaxThreads(maxWorkers, maxIo);
            ThreadPool.SetMinThreads(minWorkers, minIo);
            if (blocker != null) await blocker;
            if (scheduler != null) await scheduler.StopAsync();
        }
        if (!completedUnderPressure)
            throw new InvalidOperationException("Interactive render waited for shared worker-pool admission");
    }
}
