using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Transfer;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyTransferUndoAsync(string output)
    {
        var photo = ViewModel.SelectedPhoto ?? throw new InvalidOperationException("Transfer smoke requires an open fixture.");
        await ViewModel.PrepareMetadataAsync();
        var before = ViewModel.Adjustments.Clone();
        var depth = ViewModel.UndoCount;
        var snapshot = await TransferSnapshot.ReadAsync(photo.FilePath, null, CancellationToken.None);
        var incoming = before.Clone();
        incoming.Exposure = before.Exposure == 1.25 ? -.75 : 1.25;
        incoming.Contrast = before.Contrast == 27 ? -18 : 27;
        var patch = AdjustmentTransfer.Build(new(incoming, snapshot.Document.WbScaleVersion, null), new[] { "tone" });
        var job = await LocalTransferJob.CreateAsync(Path.Combine(output, "transfer-jobs"),
            new[] { new TransferJobInput(photo.FilePath, photo.FileName, snapshot.ExpectedHash!, patch) });
        var result = await job.RunAsync(false, CancellationToken.None);
        if (result.Applied != 1 || !await job.IsCurrentAppliedAsync(photo.FilePath))
            throw new InvalidOperationException("Transfer did not acknowledge its current sidecar.");
        // Give the native watcher time to win the reload race before the
        // explicit acknowledgement supplies the originating undo snapshot.
        await Task.Delay(650);
        await ViewModel.RefreshAfterTransferAsync(photo, before);
        if (ViewModel.UndoCount != depth + 1 || ViewModel.Adjustments.Exposure != incoming.Exposure
            || ViewModel.Adjustments.Contrast != incoming.Contrast)
            throw new InvalidOperationException("Transfer lost its single undo boundary after watcher reload.");
        ViewModel.Undo();
        await Task.Delay(550);
        if (ViewModel.UndoCount != depth || ViewModel.Adjustments.Exposure != before.Exposure
            || ViewModel.Adjustments.Contrast != before.Contrast)
            throw new InvalidOperationException("Transfer Undo did not restore the previous model.");
        ViewModel.Redo();
        if (ViewModel.Adjustments.Exposure != incoming.Exposure || ViewModel.Adjustments.Contrast != incoming.Contrast)
            throw new InvalidOperationException("Transfer Redo lost copied values.");
        ViewModel.Undo();
        await ViewModel.PrepareMetadataAsync();
    }
}
