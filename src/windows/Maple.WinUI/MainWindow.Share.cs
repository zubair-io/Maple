using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Maple.WinUI.Services.Export;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private DataTransferManager? _shareManager;
    private IReadOnlyList<StorageFile> _shareFiles = Array.Empty<StorageFile>();

    // Per-window desktop interop required by Windows Share for unpackaged WinUI.
    [ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDataTransferManagerInterop
    {
        IntPtr GetForWindow(IntPtr window, ref Guid iid);
        void ShowShareUIForWindow(IntPtr window);
    }

    private async void OnShareOriginals(object sender, RoutedEventArgs e) => await SharePhotosAsync(true);
    private async void OnSharePhotos(object sender, RoutedEventArgs e) => await SharePhotosAsync(false);

    private Task SharePhotosAsync(bool originals) => RunModalFlowGuardedAsync(async () =>
        {
            if (ViewModel.SelectedPhoto == null) return;
            using var cancellation = new CancellationTokenSource();
            var progress = new TextBlock { Text = originals ? "Preparing original files…" : "Preparing edited JPEGs…", TextWrapping = TextWrapping.Wrap };
            var dialog = new ContentDialog { XamlRoot = Content.XamlRoot, Title = "Share photos",
                Content = progress, CloseButtonText = "Cancel" };
            var preparing = true;
            dialog.Closing += (_, args) =>
            {
                if (!preparing) return;
                args.Cancel = true;
                cancellation.Cancel();
                progress.Text = "Cancelling after the current file…";
            };
            void WindowClosed(object sender, WindowEventArgs args) => cancellation.Cancel();
            Closed += WindowClosed;
            var shown = dialog.ShowAsync();
            async Task HidePreparationAsync()
            {
                preparing = false;
                dialog.Hide();
                await shown;
            }
            try
            {
                using var prepared = new PreparedShareFiles(Path.Combine(Path.GetTempPath(), "Maple", "Share"));
                var files = new List<StorageFile>();
                // Temporary outputs only; receivers may read them after this window closes.
                var directory = prepared.DirectoryPath;
                if (originals)
                {
                    var photos = ViewModel.SelectedPhotos.Count > 0 ? ViewModel.SelectedPhotos.ToArray() : new[] { ViewModel.SelectedPhoto };
                    var cloud = ViewModel.ActiveCloudClient;
                    foreach (var photo in photos)
                    {
                        cancellation.Token.ThrowIfCancellationRequested();
                        var source = photo.EditPath;
                        if (photo.IsCloud && !File.Exists(source))
                            source = await (cloud ?? throw new IOException("Connect to Maple Cloud to share this original."))
                                .DownloadOriginalAsync(photo.FilePath, photo.FileSizeBytes, null, cancellation.Token)
                                ?? throw new IOException("Could not download the original.");
                        var copy = Path.Combine(directory, $"{files.Count + 1:D3}-{Path.GetFileName(photo.FileName)}");
                        await using (var input = File.OpenRead(source))
                        await using (var output = File.Create(copy))
                            await input.CopyToAsync(output, cancellation.Token);
                        files.Add(await StorageFile.GetFileFromPathAsync(copy));
                    }
                }
                else
                {
                    var inputs = await ViewModel.CaptureExportInputsAsync(cancellation.Token);
                    var recipe = DefaultWindowsRecipe() with { Directory = directory, MaxLongEdge = 2560 };
                    var executor = new NativeExportRecipeExecutor();
                    var outputs = await prepared.RenderEditedAsync(inputs, recipe, executor, cancellation.Token,
                        (current, total) => progress.Text = $"Preparing {current} of {total}…");
                    foreach (var output in outputs)
                        files.Add(await StorageFile.GetFileFromPathAsync(output));
                }
                cancellation.Token.ThrowIfCancellationRequested();
                await HidePreparationAsync();
                if (_closing || files.Count == 0) return;
                _shareFiles = files;
                var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
                var interop = DataTransferManager.As<IDataTransferManagerInterop>();
                if (_shareManager == null)
                {
                    var iid = new Guid("A5CAEE9B-8708-49D1-8D36-67D25A8DA00C");
                    var pointer = interop.GetForWindow(hwnd, ref iid);
                    try { _shareManager = WinRT.MarshalInterface<DataTransferManager>.FromAbi(pointer); }
                    finally { Marshal.Release(pointer); }
                    _shareManager.DataRequested += (_, args) =>
                    {
                        args.Request.Data.Properties.Title = _shareFiles.Count == 1 ? "Photo from Maple" : "Photos from Maple";
                        args.Request.Data.RequestedOperation = DataPackageOperation.Copy;
                        args.Request.Data.SetStorageItems(_shareFiles);
                    };
                    Closed += (_, _) => _shareFiles = Array.Empty<StorageFile>();
                }
                interop.ShowShareUIForWindow(hwnd);
                prepared.RetainForReceiver();
            }
            catch (OperationCanceledException) { await HidePreparationAsync(); }
            catch (Exception error)
            {
                await HidePreparationAsync();
                if (!_closing) await ShowMessageAsync("Share photos", error.Message);
            }
            finally { Closed -= WindowClosed; }
        });
}
