using System;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Pano;

public sealed record PanoPreviewOutcome(bool Ok, bool Cancelled, string? Error, PanoPreviewReport? Report = null);

public sealed record PanoPreviewRun(
    PanoPreviewOptions Options, PanoPreviewFiles Files, string? AlignmentIn,
    PanoSeamRequest? Seams = null, long Sequence = 0);

public sealed record PanoPreviewCompletion(PanoPreviewRun Run, PanoPreviewOutcome Outcome);

/// <summary>The stitch dialog's live preview (#4581). Each request waits
/// out a short debounce, cancels the preview still running, and waits for
/// that process to exit before starting, so at most one maple-cli preview
/// runs at a time. Each run is offered the newest successful alignment;
/// the full stitch starts from <see cref="LatestAlignment"/>. Events are
/// raised on a background thread; a handler that hops threads compares the
/// run's sequence with <see cref="LatestSequence"/> to drop a result a newer
/// request has overtaken (#5992).</summary>
public sealed class PanoPreviewSession
{
    public delegate Task<PanoPreviewOutcome> Runner(PanoPreviewRun run, CancellationToken ct);

    public static readonly TimeSpan DefaultDebounce = TimeSpan.FromMilliseconds(600);

    private readonly PanoScratch _scratch;
    private readonly Runner _runner;
    private readonly TimeSpan _debounce;
    private readonly object _gate = new();
    private CancellationTokenSource _cts = new();
    private Task _current = Task.CompletedTask;
    private string? _latestAlignment;
    private long _sequence;

    public PanoPreviewSession(PanoScratch scratch, Runner runner, TimeSpan debounce)
    {
        _scratch = scratch;
        _runner = runner;
        _debounce = debounce;
    }

    public event Action<PanoPreviewRun>? Started;
    public event Action<PanoPreviewRun>? Succeeded;
    public event Action<string>? Failed;
    public event Action<PanoPreviewCompletion>? Completed;

    public long LatestSequence
    {
        get
        {
            lock (_gate)
            {
                return _sequence;
            }
        }
    }

    public string? LatestAlignment
    {
        get
        {
            lock (_gate)
            {
                return _latestAlignment;
            }
        }
    }

    public void Request(PanoPreviewOptions options, PanoSeamRequest? seams = null)
    {
        lock (_gate)
        {
            _cts.Cancel();
            _cts = new CancellationTokenSource();
            _sequence++;
            _current = RunAfterAsync(_current, options, seams, _sequence, _cts.Token);
        }
    }

    /// <summary>Cancel any pending or running preview and wait until its
    /// process has exited.</summary>
    public Task StopAsync()
    {
        lock (_gate)
        {
            _cts.Cancel();
            return _current;
        }
    }

    private async Task RunAfterAsync(
        Task previous, PanoPreviewOptions options, PanoSeamRequest? seams, long sequence, CancellationToken ct)
    {
        try
        {
            await Task.Delay(_debounce, ct);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        await previous;
        if (ct.IsCancellationRequested)
            return;

        var run = new PanoPreviewRun(options, _scratch.NextPreview(), LatestAlignment, seams, sequence);
        Started?.Invoke(run);
        var outcome = await RunGuardedAsync(run, ct);
        if (outcome.Cancelled || ct.IsCancellationRequested)
            return;
        if (!outcome.Ok)
        {
            Failed?.Invoke(outcome.Error ?? "preview failed");
            Completed?.Invoke(new PanoPreviewCompletion(run, outcome));
            return;
        }
        lock (_gate)
        {
            _latestAlignment = run.Files.AlignmentJson;
        }
        Succeeded?.Invoke(run);
        Completed?.Invoke(new PanoPreviewCompletion(run, outcome));
    }

    // A runner that throws (maple-cli.exe unlaunchable) must still end this
    // run's task cleanly: the next request awaits it.
    private async Task<PanoPreviewOutcome> RunGuardedAsync(PanoPreviewRun run, CancellationToken ct)
    {
        try
        {
            return await _runner(run, ct);
        }
        catch (OperationCanceledException)
        {
            return new PanoPreviewOutcome(false, true, null);
        }
        catch (Exception ex)
        {
            return new PanoPreviewOutcome(false, false, ex.Message);
        }
    }
}
