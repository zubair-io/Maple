using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    // #3878: a metadata dialog must wait for earlier autosaves before reading
    // its preview. Keep failures until observed; a logged error is not a save.
    private readonly object _cloudMetadataGate = new();
    private readonly List<Task> _cloudMetadataWrites = new();

    private void TrackCloudMetadataWrite(Task write)
    {
        lock (_cloudMetadataGate)
        {
            _cloudMetadataWrites.RemoveAll(task => task.IsCompletedSuccessfully);
            _cloudMetadataWrites.Add(write);
        }
        _ = ReportCloudMetadataWriteAsync(write);
    }

    private async Task ReportCloudMetadataWriteAsync(Task write)
    {
        try { await write; }
        catch (Exception error)
        {
            Services.DiagLog.Write($"[cloud] metadata save failed: {error.Message}");
            OnUi(() => CloudStatus = $"Sidecar sync failed: {error.Message}");
        }
    }

    public async Task AwaitCloudMetadataWritesAsync()
    {
        Task[] writes;
        lock (_cloudMetadataGate) writes = _cloudMetadataWrites.ToArray();
        await Task.WhenAll(writes);
        lock (_cloudMetadataGate)
            _cloudMetadataWrites.RemoveAll(task => task.IsCompletedSuccessfully);
    }
}
