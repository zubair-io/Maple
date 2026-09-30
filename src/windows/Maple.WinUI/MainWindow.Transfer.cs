using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.UI;
using Maple.UI.Atoms;
using Maple.WinUI.Generated;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Transfer;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private sealed record TransferPhoto(string Path, string Name, bool Cloud, string Id);
    private sealed record CopiedSettings(TransferPhoto Photo, TransferSnapshot Snapshot, CloudClient? Client);
    private CopiedSettings? _copiedSettings;
    private static string TransferRoot => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maple", "AdjustmentTransfers");
    private static string LocalTransferRoot => Path.Combine(TransferRoot, "local");
    private static string CloudTransferRoot => Path.Combine(TransferRoot, "cloud");
    private static TransferPhoto FreezeTransferPhoto(ViewModels.PhotoItem photo) =>
        new(photo.FilePath, photo.FileName, photo.IsCloud, photo.IsCloud ? photo.CloudAddress ?? photo.FilePath : photo.FilePath);

    private async void OnCopySettings(object sender, RoutedEventArgs e) => await RunModalFlowGuardedAsync(async () =>
    {
        try
        {
            _copiedSettings = await CaptureSettingsAsync();
            AnnounceRename("Copied settings from " + _copiedSettings.Photo.Name);
        }
        catch (Exception error) { await ShowMessageAsync("Copy settings", error.Message); }
    });

    private async Task<CopiedSettings> CaptureSettingsAsync()
    {
        var photo = ViewModel.SelectedPhoto ?? throw new InvalidOperationException("Select the source photo first.");
        var frozen = FreezeTransferPhoto(photo);
        var cloud = frozen.Cloud ? ViewModel.ActiveCloudClient ?? throw new InvalidOperationException("Connect to the source server first.") : null;
        await ViewModel.PrepareMetadataAsync();
        return new(frozen, await TransferSnapshot.ReadAsync(frozen.Path, cloud, CancellationToken.None), cloud);
    }

    private async void OnPasteSettings(object sender, RoutedEventArgs e) => await RunModalFlowGuardedAsync(() => TransferSettingsAsync(false));
    private async void OnSyncSettings(object sender, RoutedEventArgs e) => await RunModalFlowGuardedAsync(() => TransferSettingsAsync(true));

    private async Task TransferSettingsAsync(bool sync)
    {
        try
        {
            var selected = _mode == ShellMode.Browse ? ViewModel.SelectedPhotos.ToArray() :
                ViewModel.SelectedPhoto is { } current ? new[] { current } : Array.Empty<ViewModels.PhotoItem>();
            var targets = selected.Select(FreezeTransferPhoto).ToArray();
            var source = sync ? await CaptureSettingsAsync() : _copiedSettings ?? throw new InvalidOperationException("Copy settings from a photo first.");
            if (sync) targets = targets.Where(t => t.Path != source.Photo.Path || t.Cloud != source.Photo.Cloud).ToArray();
            if (targets.Length == 0) throw new InvalidOperationException(sync ? "Select the source and at least one other photo to sync." : "Select at least one target photo.");
            var cloud = targets.Any(t => t.Cloud) ? ViewModel.ActiveCloudClient ?? throw new InvalidOperationException("Connect to the target server first.") : null;
            await ViewModel.PrepareMetadataAsync();
            var prepared = await PreviewTransferAsync(source, targets, cloud);
            if (prepared == null) return;
            var jobs = await PrepareTransferJobsAsync(targets, cloud, prepared);
            if (jobs == null) return;
            var (localJob, cloudJob) = jobs.Value;
            var currentPhoto = ViewModel.SelectedPhoto;
            var undoBefore = currentPhoto != null && prepared.Snapshots.TryGetValue(FreezeTransferPhoto(currentPhoto).Id, out var original)
                ? original.Document.Adjustments.Clone() : null;
            if (localJob != null) await ShowTransferJobAsync(localJob, null, start: true, currentPhoto?.IsCloud == false ? undoBefore : null);
            if (cloudJob != null) await ShowTransferJobAsync(null, cloudJob, start: true, currentPhoto?.IsCloud == true ? undoBefore : null);
        }
        catch (Exception error) { await ShowMessageAsync("Transfer settings", error.Message + "\nAny prepared jobs remain available in Edit → Transfer recovery."); }
    }

    private sealed record PreparedTransfer(TransferPreviewResult Preview, Dictionary<string, TransferSnapshot> Snapshots, WhiteBalanceBaseline? Correction);

    private async Task<PreparedTransfer?> PreviewTransferAsync(CopiedSettings source, TransferPhoto[] targets, CloudClient? cloud)
    {
        var fields = new TransferPreviewFields();
        var modal = new MuiSelectivePasteModal(embedded: true)
        {
            IsOpen = true, Contained = true, CanApply = false,
            Title = $"Settings from {source.Photo.Name}", ApplyLabel = $"Apply to {targets.Length} photo{(targets.Length == 1 ? "" : "s")}",
            Groups = AdjustmentFields.Groups.Select(g => new MuiSelectivePasteGroup(g.Id, g.Label)).ToArray(),
            SelectedGroupIds = AdjustmentFields.Groups.Select(g => g.Id).ToArray(), PreviewContent = fields.Root,
            BodyMaxHeight = Math.Max(160, Math.Min(520, Content.XamlRoot.Size.Height - 220)),
        };
        var retry = new MuiButton { Label = "Reload preview", Variant = MuiButtonVariant.Ghost };
        fields.Root.Children.Add(retry);
        var host = new ContentDialog { XamlRoot = Content.XamlRoot, Content = modal };
        var snapshots = new Dictionary<string, TransferSnapshot>();
        var baselines = new Dictionary<string, WhiteBalanceBaseline>();
        WhiteBalanceBaseline? sourceBaseline = null;
        PreparedTransfer? preview = null;
        PreparedTransfer? accepted = null;
        CancellationTokenSource? operation = null;
        bool busy = false;
        void Status(string text) { fields.Status.Text = text; AnnounceRename(text); }
        void Refresh()
        {
            preview = null;
            modal.CanApply = false;
            if (busy || snapshots.Count != targets.Length) return;
            try
            {
                var relative = fields.Relative.CheckedState == true && modal.SelectedGroupIds!.Contains("white_balance");
                var clipboard = new AdjustmentTransferSource(source.Snapshot.Document.Adjustments, source.Snapshot.Document.WbScaleVersion, sourceBaseline);
                var result = TransferPreview.Build(clipboard, modal.SelectedGroupIds!, targets.Select(t =>
                    new TransferPreviewTarget(t.Id, t.Name, snapshots[t.Id].Document, baselines.TryGetValue(t.Id, out var b) ? b : null)).ToArray(), relative);
                fields.Show(result);
                preview = new(result, snapshots, relative ? AdjustmentTransfer.Correction(clipboard) : null);
                modal.CanApply = result.Groups.Any(g => g.Fields.Count > 0);
                Status($"Review current and incoming values for {targets.Length} photo{(targets.Length == 1 ? "" : "s")}. Apply writes the checked groups.");
            }
            catch (Exception error) { Status(error.Message); }
        }
        async Task ReadAsync(bool reload)
        {
            if (busy) return;
            busy = true;
            operation?.Dispose(); operation = new();
            modal.IsApplying = true; modal.CanApply = false; modal.GroupsEnabled = false;
            fields.Relative.IsEnabled = false; retry.IsEnabled = false;
            try
            {
                if (reload) snapshots.Clear();
                foreach (var target in targets)
                {
                    Status("Reading " + target.Name);
                    if (!snapshots.ContainsKey(target.Id)) snapshots.Add(target.Id,
                        await TransferSnapshot.ReadAsync(target.Path, target.Cloud ? cloud : null, operation.Token));
                }
                if (fields.Relative.CheckedState == true)
                {
                    Status("Reading source camera white balance…");
                    sourceBaseline ??= source.Photo.Cloud
                        ? await source.Client!.GetTransferBaselineAsync(source.Photo.Path, operation.Token)
                        : await TransferBaseline.ReadAsync(source.Photo.Path, operation.Token);
                    foreach (var target in targets)
                    {
                        Status("Reading camera white balance: " + target.Name);
                        if (!baselines.ContainsKey(target.Id)) baselines.Add(target.Id, target.Cloud
                            ? await cloud!.GetTransferBaselineAsync(target.Path, operation.Token)
                            : await TransferBaseline.ReadAsync(target.Path, operation.Token));
                    }
                }
            }
            catch (OperationCanceledException) { Status("Preview loading cancelled. No photos changed."); }
            catch (Exception error) { Status(error.Message); }
            finally
            {
                busy = false; modal.IsApplying = false; modal.GroupsEnabled = true;
                fields.Relative.IsEnabled = true; retry.IsEnabled = true;
                if (!operation.IsCancellationRequested) Refresh();
            }
        }
        modal.SelectionChanged += (_, _) => Refresh();
        fields.Relative.Checked += async (_, _) => await ReadAsync(false);
        fields.Relative.Unchecked += (_, _) => Refresh();
        retry.Click += async (_, _) => await ReadAsync(true);
        modal.PasteRequested += (_, _) => { if (!busy && preview != null) { accepted = preview; host.Hide(); } };
        modal.CancelRequested += (_, _) => operation?.Cancel();
        modal.Dismissed += (_, _) => host.Hide();
        host.Opened += async (_, _) => await ReadAsync(true);
        host.Closing += (_, args) => { if (busy) { args.Cancel = true; operation?.Cancel(); } };
        try { await host.ShowAsync(); }
        finally { operation?.Dispose(); }
        return accepted;
    }
}
