using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.UI.Atoms;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Transfer;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task<(LocalTransferJob? Local, CloudTransferJob? Cloud)?> PrepareTransferJobsAsync(
        TransferPhoto[] targets, CloudClient? cloud, PreparedTransfer prepared)
    {
        using var cancellation = new CancellationTokenSource();
        var panel = new StackPanel { Spacing = 12 };
        panel.Children.Add(new TextBlock { Text = "Saving the recovery plan before changing any photos.", TextWrapping = Microsoft.UI.Xaml.TextWrapping.Wrap });
        panel.Children.Add(new MuiProgress { IsIndeterminate = true, Label = "Preparing transfer" });
        var host = new ContentDialog { Title = "Preparing transfer", Content = panel, XamlRoot = Content.XamlRoot, CloseButtonText = "Cancel" };
        LocalTransferJob? localJob = null;
        CloudTransferJob? cloudJob = null;
        Exception? failure = null;
        bool busy = true;
        host.Closing += (_, args) =>
        {
            if (busy) { args.Cancel = true; cancellation.Cancel(); }
        };
        host.Opened += async (_, _) =>
        {
            try
            {
                // Publish every ledger before the first photo write. Recovery
                // can find completed preparations if cancellation or exit occurs
                // between local and cloud preparation.
                var localInputs = targets.Where(t => !t.Cloud).Select(t => new TransferJobInput(t.Path, t.Name,
                    prepared.Snapshots[t.Id].ExpectedHash!, prepared.Preview.Patches[t.Id])).ToArray();
                if (localInputs.Length > 0) localJob = await LocalTransferJob.CreateAsync(LocalTransferRoot, localInputs, cancellation.Token);
                cancellation.Token.ThrowIfCancellationRequested();
                var cloudTargets = targets.Where(t => t.Cloud).ToArray();
                if (cloudTargets.Length > 0)
                    cloudJob = await CloudTransferJob.PrepareAsync(CloudTransferRoot, cloud!,
                        cloudTargets.Select(t => new CloudTransferTarget(t.Id, t.Path)).ToArray(),
                        cloudTargets.ToDictionary(t => t.Id, t => t.Name), prepared.Preview.Patches[cloudTargets[0].Id], prepared.Correction);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
            catch (Exception error) { failure = error; }
            finally { busy = false; host.Hide(); }
        };
        await host.ShowAsync();
        if (failure != null) throw failure;
        if (cancellation.IsCancellationRequested)
        {
            await ShowMessageAsync("Transfer cancelled", "No photo writes started. Any completed recovery plans are available in Edit → Transfer recovery.");
            return null;
        }
        return (localJob, cloudJob);
    }
}
