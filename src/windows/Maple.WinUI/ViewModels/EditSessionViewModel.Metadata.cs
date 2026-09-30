using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    // #3878: a metadata dialog must wait for earlier autosaves before reading
    // its preview. Keep failures until observed; a logged error is not a save.
    private readonly object _cloudMetadataGate = new();
    private readonly Queue<Func<Task>> _cloudMetadataWrites = new();
    private Task _cloudMetadataWorker = Task.CompletedTask;
    private bool _cloudMetadataRunning;
    private Exception? _cloudMetadataError;
    private readonly object _localMetadataGate = new();
    private Exception? _localMetadataError;

    private void TrackCloudMetadataWrite(Func<Task> write)
    {
        lock (_cloudMetadataGate)
        {
            _cloudMetadataWrites.Enqueue(write);
            if (!_cloudMetadataRunning && _cloudMetadataError == null)
            {
                _cloudMetadataRunning = true;
                _cloudMetadataWorker = Task.Run(RunCloudMetadataWritesAsync);
            }
        }
    }

    private async Task RunCloudMetadataWritesAsync()
    {
        while (true)
        {
            Func<Task> write;
            lock (_cloudMetadataGate)
            {
                if (_cloudMetadataWrites.Count == 0) { _cloudMetadataRunning = false; return; }
                write = _cloudMetadataWrites.Peek();
            }
            try { await write(); }
            catch (Exception error)
            {
                lock (_cloudMetadataGate) { _cloudMetadataError = error; _cloudMetadataRunning = false; }
                Services.DiagLog.Write($"[cloud] metadata save failed: {error.Message}");
                OnUi(() => CloudStatus = $"Sidecar sync failed: {error.Message}");
                return;
            }
            lock (_cloudMetadataGate) _cloudMetadataWrites.Dequeue();
        }
    }

    public async Task PrepareMetadataAsync()
    {
        if (_openPhoto?.IsCloud == true)
        {
            await _cloudSidecarLoad;
            if (_cloudSidecarLoadError != null)
                throw new InvalidOperationException("Opening cloud metadata failed: " + _cloudSidecarLoadError.Message);
        }
        _sidecarTimer?.Dispose();
        // The modal prevents edits while this runs. Flush the previous
        // adjustment snapshot before reading metadata; failed writes remain
        // dirty so retry can save them instead of silently discarding edits.
        await Task.Run(FlushSidecarNow);
        if (_localMetadataError != null)
            throw new InvalidOperationException("Pending adjustment save failed: " + _localMetadataError.Message);
        Task worker;
        lock (_cloudMetadataGate)
        {
            if (!_cloudMetadataRunning && _cloudMetadataWrites.Count > 0)
            {
                _cloudMetadataError = null;
                _cloudMetadataRunning = true;
                _cloudMetadataWorker = Task.Run(RunCloudMetadataWritesAsync);
            }
            worker = _cloudMetadataWorker;
        }
        await worker;
        if (_cloudMetadataError != null)
            throw new InvalidOperationException("Pending cloud save failed: " + _cloudMetadataError.Message);
    }
}
