using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.UI.Atoms;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Transfer;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async void OnTransferRecovery(object sender, RoutedEventArgs e) => await RunModalFlowGuardedAsync(async () =>
    {
        var rows = new StackPanel { Spacing = 12 };
        var host = new ContentDialog { Title = "Transfer recovery", XamlRoot = Content.XamlRoot,
            Content = new ScrollViewer { Content = rows, MaxHeight = 440 }, CloseButtonText = "Close" };
        Func<Task>? selected = null;
        void Add(string label, Func<Task> open)
        {
            var button = new MuiButton { Label = label, HorizontalAlignment = HorizontalAlignment.Stretch };
            button.Click += (_, _) => { selected = open; host.Hide(); };
            rows.Children.Add(button);
        }
        try
        {
            if (Directory.Exists(LocalTransferRoot))
                foreach (var directory in Directory.EnumerateDirectories(LocalTransferRoot).OrderDescending())
                {
                    if (!File.Exists(Path.Combine(directory, "job.json"))) continue;
                    var id = Path.GetFileName(directory);
                    try
                    {
                        var job = await LocalTransferJob.OpenAsync(LocalTransferRoot, id);
                        var summary = await job.SummaryAsync();
                        Add($"Local • {File.GetLastWriteTime(Path.Combine(directory, "job.json")):g} • {summary.Applied} applied, {summary.Pending} pending, {summary.Failures.Count} failed",
                            () => ShowTransferJobAsync(job, null, false));
                    }
                    catch (Exception error)
                    {
                        rows.Children.Add(new TextBlock { Text = $"Could not read job {id}: {error.Message}", TextWrapping = TextWrapping.Wrap });
                    }
                }
            if (Directory.Exists(CloudTransferRoot))
                foreach (var path in Directory.EnumerateFiles(CloudTransferRoot, "*.json").OrderDescending())
                {
                    var id = Path.GetFileNameWithoutExtension(path);
                    Add($"Cloud transfer • {File.GetLastWriteTime(path):g}", async () =>
                    {
                        var client = ViewModel.ActiveCloudClient ?? throw new InvalidOperationException("Connect to the original server to recover this transfer.");
                        var job = await CloudTransferJob.OpenAsync(CloudTransferRoot, id, client);
                        await ShowTransferJobAsync(null, job, false);
                    });
                }
            if (rows.Children.Count == 0) rows.Children.Add(new TextBlock { Text = "No saved transfer jobs." });
            await host.ShowAsync();
            if (selected != null) await selected();
        }
        catch (Exception error) { await ShowMessageAsync("Transfer recovery", error.Message); }
    });

    private async Task ShowTransferJobAsync(LocalTransferJob? local, CloudTransferJob? cloud, bool start, Models.AdjustmentState? undoBefore = null)
    {
        var status = new TextBlock { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
        AutomationProperties.SetLiveSetting(status, AutomationLiveSetting.Polite);
        var failures = new TextBlock { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
        var progress = new MuiProgress { Label = "Transfer progress" };
        var resume = new MuiButton { Label = "Resume pending" };
        var retry = new MuiButton { Label = "Retry failed only" };
        var reconnect = new MuiButton { Label = cloud == null ? "Refresh status" : "Refresh status / reconnect" };
        var panel = new StackPanel { Spacing = 12 };
        panel.Children.Add(status); panel.Children.Add(progress);
        panel.Children.Add(new ScrollViewer { Content = failures, MaxHeight = 220 });
        panel.Children.Add(resume); panel.Children.Add(retry); panel.Children.Add(reconnect);
        var host = new ContentDialog { Title = "Transfer settings", Content = panel, XamlRoot = Content.XamlRoot, CloseButtonText = "Close" };
        CancellationTokenSource? operation = null;
        bool busy = false;
        bool canResume = false, canRetry = false;
        var selectedPhoto = ViewModel.SelectedPhoto;
        void Status(string text) { status.Text = text; AnnounceRename(text); }
        void Enable()
        {
            resume.IsEnabled = !busy && canResume;
            retry.IsEnabled = !busy && canRetry;
            reconnect.IsEnabled = !busy;
            host.CloseButtonText = busy ? "Cancel after current photo" : "Close";
        }
        void LocalSummary(TransferJobSummary summary)
        {
            canResume = summary.Pending > 0; canRetry = summary.Failures.Count > 0;
            Status($"{summary.Applied} applied, {summary.Pending} pending, {summary.Failures.Count} failed." + (summary.Cancelled ? " Cancelled after the in-flight write." : ""));
            failures.Text = string.Join("\n", summary.Failures.Select(f => f.Name + ": " + f.Reason));
            progress.Value = 100.0 * (summary.Applied + summary.Failures.Count) / local!.Count;
        }
        void CloudSummary(CloudTransferStatus state)
        {
            var result = state.Result ?? state.Checkpoint;
            var running = state.Status is "queued" or "running";
            canResume = !running && result?.Remaining.Length > 0;
            canRetry = !running && result?.Failed.Length > 0;
            progress.Value = state.Progress.Total == 0 ? 0 : 100.0 * state.Progress.Current / state.Progress.Total;
            string Name(string id) => cloud!.Names.TryGetValue(id, out var name) ? name : id;
            failures.Text = result == null ? "" : string.Join("\n", result.Failed.Select(f => Name(f.Id) + ": " + f.Reason));
            Status($"Server: {state.Status}. {state.Progress.Current} of {state.Progress.Total} processed." +
                (result == null ? "" : $" {result.Applied.Length} applied, {result.Failed.Length} failed, {result.Remaining.Length} pending.") +
                (state.Error == null ? "" : " " + state.Error));
        }
        async Task RunAsync(string action)
        {
            if (busy) return;
            busy = true; operation?.Dispose(); operation = new(); Enable();
            try
            {
                string[] cloudApplied = [];
                await ViewModel.PrepareMetadataAsync();
                if (local != null)
                {
                    if (action == "refresh") LocalSummary(await local.SummaryAsync());
                    else LocalSummary(await local.RunAsync(action == "retry", operation.Token,
                        new TransferProgress(p => { progress.Value = 100.0 * (p.Applied + p.Failed) / p.Total; Status($"{p.Applied} applied, {p.Failed} failed, {p.Pending} pending. {p.Current}"); })));
                    if (undoBefore != null && (selectedPhoto == null || !await local.IsCurrentAppliedAsync(selectedPhoto.FilePath))) undoBefore = null;
                }
                else
                {
                    if (cloud!.SubmissionPending && (action == "refresh" || operation.IsCancellationRequested))
                    {
                        canResume = true; canRetry = false;
                        Status("Submission is not acknowledged. Resume pending reconnects using the saved request, without creating a duplicate job.");
                        return;
                    }
                    if (cloud.SubmissionPending) await cloud.SubmitPendingAsync(CancellationToken.None);
                    else if (action is "resume" or "retry") await cloud.ContinueAsync(action == "retry", CancellationToken.None);
                    bool cancelSent = false;
                    while (true)
                    {
                        var state = await cloud.ReadAsync(CancellationToken.None);
                        CloudSummary(state);
                        if (state.Status is not ("queued" or "running"))
                        {
                            cloudApplied = (state.Result ?? state.Checkpoint)?.Applied ?? [];
                            var selectedId = selectedPhoto?.CloudAddress ?? selectedPhoto?.FilePath;
                            if (selectedId == null || (state.Result ?? state.Checkpoint)?.Applied.Contains(selectedId) != true) undoBefore = null;
                            break;
                        }
                        if (operation.IsCancellationRequested && !cancelSent)
                        {
                            await cloud.CancelAsync(CancellationToken.None);
                            cancelSent = true;
                            Status("Server cancellation requested; waiting for the in-flight write…");
                        }
                        await Task.Delay(750);
                    }
                }
                if (selectedPhoto != null)
                {
                    await ViewModel.RefreshAfterTransferAsync(selectedPhoto, undoBefore);
                    undoBefore = null;
                }
                if (local != null) await ViewModel.RefreshLocalTransferThumbnailsAsync(local);
                else await ViewModel.RefreshCloudTransferThumbnailsAsync(cloud!.Client, cloudApplied);
            }
            catch (Exception error)
            {
                Status(error.Message + "\nThe saved job is retained. Refresh status or reopen Edit → Transfer recovery before trying again.");
            }
            finally { busy = false; Enable(); }
        }
        resume.Click += async (_, _) => await RunAsync("resume");
        retry.Click += async (_, _) => await RunAsync("retry");
        reconnect.Click += async (_, _) => await RunAsync("refresh");
        host.Opened += async (_, _) => await RunAsync(start ? "start" : "refresh");
        host.Closing += (_, args) =>
        {
            if (busy) { args.Cancel = true; operation?.Cancel(); Status("Cancelling after the current operation…"); }
        };
        try { await host.ShowAsync(); }
        finally { operation?.Dispose(); }
    }

    private sealed class TransferProgress(Action<TransferJobProgress> report) : IProgress<TransferJobProgress>
    {
        public void Report(TransferJobProgress progress) => report(progress);
    }
}
