using System;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    // #3878: a metadata dialog must wait for earlier autosaves before reading
    // its preview. Keep failures until observed; a logged error is not a save.
    private readonly PendingCloudSidecarWrites _cloudMetadataWrites = new();
    private readonly object _localMetadataGate = new();
    private readonly Services.Xmp.PendingLocalSidecarWrites _localMetadataWrites = new();
    private Exception? _localMetadataError;
    private string _localSaveError = string.Empty;
    public string LocalSaveError
    {
        get => _localSaveError;
        private set
        {
            if (SetProperty(ref _localSaveError, value)) OnPropertyChanged(nameof(HasLocalSaveError));
        }
    }
    public bool HasLocalSaveError => !string.IsNullOrEmpty(LocalSaveError);

    public Task RetryLocalSaveAsync() => Task.Run(FlushSidecarNow);

    private void TrackCloudMetadataWrite(Func<Task> write) => _cloudMetadataWrites.Enqueue(write);

    private void OnCloudMetadataFailure(Exception error)
    {
        Services.DiagLog.Write($"[cloud] metadata save failed: {error.Message}");
        OnUi(() => CloudStatus = $"Sidecar sync failed: {error.Message}");
    }

    public async Task PrepareMetadataAsync()
    {
        if (_openPhoto?.IsCloud == true)
        {
            await _cloudSidecarLoad;
            // The dialog performs its own strict, fresh read below. An earlier
            // preview-sidecar fetch failure must not permanently poison Retry.
            // Wait for that fetch so it cannot publish stale culling after us.
        }
        _sidecarTimer?.Dispose();
        // The modal prevents edits while this runs. Flush the previous
        // adjustment snapshots before reading metadata; failed writes remain
        // queued by photo so navigation cannot silently discard those edits.
        await Task.Run(FlushSidecarNow);
        if (_localMetadataError != null)
            throw new InvalidOperationException("Pending adjustment save failed: " + _localMetadataError.Message);
        await _cloudMetadataWrites.DrainAsync(retryFailed: true);
    }

    private static Task OnUiAcknowledgedAsync(Action action)
    {
        var queue = App.MainDispatcherQueue;
        if (queue == null || queue.HasThreadAccess)
        {
            action();
            return Task.CompletedTask;
        }
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!queue.TryEnqueue(() =>
        {
            try { action(); completion.SetResult(); }
            catch (Exception error) { completion.SetException(error); }
        })) completion.SetException(new InvalidOperationException("The window closed before metadata could be refreshed."));
        return completion.Task;
    }
}
