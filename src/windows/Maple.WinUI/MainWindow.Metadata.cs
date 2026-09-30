using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async void OnEditSelectionMetadata(object sender, RoutedEventArgs e) =>
        await RunModalFlowGuardedAsync(() => EditMetadataAsync(ViewModel.SelectedPhotos.ToArray()));

    private async void OnEditPhotoMetadata(object sender, RoutedEventArgs e) =>
        await RunModalFlowGuardedAsync(() => EditMetadataAsync(ViewModel.SelectedPhoto is { } photo ? new[] { photo } : Array.Empty<PhotoItem>()));

    private async Task EditMetadataAsync(PhotoItem[] photos)
    {
        if (photos.Length == 0)
        {
            await ShowMessageAsync("Edit metadata", "Select one or more photos first.");
            return;
        }
        var cloud = ViewModel.ActiveCloudClient;
        if (photos.Any(p => p.IsCloud && (p.CloudAddress == null || cloud == null)))
        {
            await ShowMessageAsync("Edit metadata", "The selected cloud photos need a connected server and a valid library address.");
            return;
        }
        var fields = new MetadataFields();
        var retryRead = new MuiButton { Label = "Retry loading metadata", Visibility = Visibility.Collapsed };
        fields.Root.Children.Add(retryRead);
        var modal = new MuiBatchMetadataModal(embedded: true)
        {
            Contained = true, IsOpen = true, AssetCount = photos.Length,
            EditorContent = fields.Root, CanApply = false,
            EditorMaxHeight = Math.Max(180, Math.Min(520, ((Content as FrameworkElement)?.XamlRoot?.Size.Height ?? 700) - 220)),
        };
        var host = new ContentDialog
        {
            Content = modal, XamlRoot = (Content as FrameworkElement)?.XamlRoot,
            DefaultButton = ContentDialogButton.None,
        };
        MetadataBatchItem[] items = Array.Empty<MetadataBatchItem>();
        MetadataBatch? applied = null;
        CancellationTokenSource? operation = null;
        var busy = false;

        void Status(string text)
        {
            fields.Status.Text = text;
            AnnounceRename(text);
        }
        void RefreshPreview()
        {
            if (items.Length == 0 || applied != null || busy) return;
            try
            {
                var batch = new MetadataBatch(items, fields.Patch(), cloud);
                fields.ShowPreview(batch, false);
                modal.CanApply = batch.Patch.HasChanges;
                modal.ConfirmationMessage = $"Apply the previewed changes to {photos.Length} selected photos? Unchanged fields and original files are preserved.";
            }
            catch (Exception error) { modal.CanApply = false; Status(error.Message); }
        }
        void BeginOperation()
        {
            operation?.Dispose();
            operation = new();
            busy = true;
            fields.SetEnabled(false);
            modal.IsApplying = true;
            modal.CancelLabel = "Cancel";
            modal.ApplyProgress = 0;
        }
        void EndOperation()
        {
            busy = false;
            modal.IsApplying = false;
            fields.SetEnabled(applied == null && items.Length > 0);
        }
        async Task ReadAsync()
        {
            BeginOperation();
            items = Array.Empty<MetadataBatchItem>();
            modal.CanApply = false;
            retryRead.Visibility = Visibility.Collapsed;
            Status("Saving pending adjustments and reading selected metadata…");
            try
            {
                await ViewModel.PrepareMetadataAsync();
                var loaded = new List<MetadataBatchItem>();
                foreach (var photo in photos)
                {
                    var target = new MetadataTarget(photo.FilePath, photo.FileName, photo.IsCloud ? photo.CloudAddress : null);
                    try { loaded.Add(new(target, await MetadataBatch.ReadAsync(target, cloud, operation!.Token))); }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception error) { throw new InvalidOperationException($"{photo.FileName}: {error.Message}", error); }
                    modal.ApplyProgress = 100.0 * loaded.Count / photos.Length;
                    Status($"Read {loaded.Count} of {photos.Length} photos.");
                }
                items = loaded.ToArray();
                fields.ShowCurrent(items);
                Status($"{items.Length} photo{(items.Length == 1 ? "" : "s")} selected. Choose changes to preview.");
            }
            catch (OperationCanceledException) { Status("Loading cancelled. No metadata changes were applied."); }
            catch (Exception error) { Status(error.Message); }
            finally
            {
                EndOperation();
                retryRead.Visibility = items.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                RefreshPreview();
            }
        }
        async Task ApplyAsync()
        {
            if (busy || items.Length == 0) return;
            try
            {
                applied ??= new MetadataBatch(items, fields.Patch(), cloud);
                BeginOperation();
                await applied.ApplyAsync(operation!.Token, new MetadataProgress(item =>
                {
                    if (item.Saved is { } saved)
                    {
                        var photo = photos[Array.IndexOf(items, item)];
                        photo.Rating = saved.Rating;
                        photo.FlagStatus = saved.Flag;
                        photo.ColorLabel = saved.Label;
                    }
                    modal.ApplyProgress = 100.0 * items.Count(i => i.Saved != null || i.Error != null) / items.Length;
                    fields.ShowPreview(applied, true);
                    Status($"Saved {items.Count(i => i.Saved != null)} of {items.Length}; failed {items.Count(i => i.Error != null)}.");
                }));
            }
            catch (Exception error) { Status(error.Message); }
            finally
            {
                EndOperation();
                var remaining = items.Count(i => i.Saved == null);
                modal.CanApply = remaining > 0;
                modal.ApplyLabel = "Retry unfinished";
                modal.ConfirmationMessage = $"Retry the {remaining} unfinished photos? Already saved photos will not be reapplied.";
                modal.CancelLabel = "Close";
                if (applied != null) fields.ShowPreview(applied, true);
                Status($"Saved {items.Length - remaining} of {items.Length}. {remaining} unfinished; see per-photo results.");
                CancelInspectorHydration();
                RefreshPhotoInfo();
            }
        }
        modal.Dismissed += (_, _) => host.Hide();
        modal.CancelRequested += (_, _) => { operation?.Cancel(); Status("Cancelling after the current operation…"); };
        modal.ApplyRequested += async (_, _) => await ApplyAsync();
        fields.Changed += RefreshPreview;
        retryRead.Click += async (_, _) => await ReadAsync();
        host.Opened += async (_, _) => await ReadAsync();
        host.Closing += (_, args) =>
        {
            if (!busy) return;
            args.Cancel = true;
            operation?.Cancel();
        };
        try { await host.ShowAsync(); }
        finally { operation?.Dispose(); modal.IsOpen = false; }
    }

    // ApplyAsync resumes on the UI context. Report inline so completion cannot
    // overtake a posted Progress<T> callback and leave the photo model stale.
    private sealed class MetadataProgress(Action<MetadataBatchItem> report) : IProgress<MetadataBatchItem>
    {
        public void Report(MetadataBatchItem item) => report(item);
    }
}
