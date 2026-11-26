using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private bool _demosaicChoiceVerified;

    private sealed class DemosaicFrameProbe
    {
        private DecodedImage? _last;
        public DecodedImage? Last => Volatile.Read(ref _last);
        public void Gpu(DecodedImage source, int width, int height, double millis, bool fullRes) => Volatile.Write(ref _last, source);
        public void Cpu(DecodedImage source, byte[] bgra, int width, int height, uint[] bins, double millis) => Volatile.Write(ref _last, source);
    }

    private static async Task<string> DemosaicHashAsync(string path) =>
        Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(path)));

    private async Task VerifyDemosaicChoiceAsync(string raw, string output)
    {
        var evidencePath = Path.Combine(output, "demosaic-choice.json");
        var previous = ViewModel.SelectedPhoto;
        if (previous == null)
        {
            await File.WriteAllTextAsync(evidencePath, JsonSerializer.Serialize(new
                { passed = true, skipped = true, skipReason = "No photo is open, so there is no Bayer frame to edit" }));
            return;
        }
        var pathA = Path.Combine(output, "demosaic-a.dng");
        var pathB = Path.Combine(output, "demosaic-b.dng");
        File.Copy(raw, pathA);
        File.Copy(raw, pathB);
        var originals = new[] { raw, pathA, pathB };
        var hashesBefore = await Task.WhenAll(originals.Select(DemosaicHashAsync));
        var photoA = new PhotoItem { FilePath = pathA, FileName = Path.GetFileName(pathA), Format = "DNG" };
        var photoB = new PhotoItem { FilePath = pathB, FileName = Path.GetFileName(pathB), Format = "DNG" };
        var renderer = ViewModel.Renderer;
        var probe = new DemosaicFrameProbe();
        var originalMode = _mode;
        var originalGroup = _activeGroup;
        var originalSelection = ViewModel.SelectedPhotos;
        var decodeErrors = 0;
        var passed = false;
        const string Auto = nameof(DemosaicChoice.Auto);
        var chosen = nameof(DemosaicChoice.Rcd);

        void OnViewModelChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
        {
            if (e.PropertyName == nameof(EditSessionViewModel.HasDecodeError) && ViewModel.HasDecodeError) decodeErrors++;
        }
        void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException("Demosaic choice: " + message);
        }
        string State()
        {
            var detail = renderer.DetailSource;
            return $"selected={ViewModel.SelectedPhoto?.FileName}, decoding={ViewModel.IsDecoding}, status={ViewModel.DecodeStatus}, "
                + $"decodeErrors={decodeErrors}, detail={(detail == null ? "none" : detail.ProfileSource?.Path ?? "no source identity")}";
        }
        async Task WaitFor(Func<bool> condition, string what, bool failOnDecodeError = true)
        {
            var deadline = Environment.TickCount64 + 20000;
            while (!condition() && Environment.TickCount64 < deadline)
            {
                if (failOnDecodeError) Require(decodeErrors == 0, $"a decode error was reported while waiting for {what} ({State()})");
                await Task.Delay(20);
            }
            if (!condition()) throw new TimeoutException($"Demosaic choice: {what} did not happen within 20 s ({State()})");
        }
        // The Auto Profile fit stamps each decode with its source path: the only per-photo
        // identity a decoded image carries, since both copies hold identical pixels.
        bool ShowsPhoto(DecodedImage? image, PhotoItem photo) =>
            image?.ProfileSource is { } source
            && string.Equals(source.Path, Path.GetFullPath(photo.EditPath), StringComparison.OrdinalIgnoreCase);
        bool FrameShows(PhotoItem photo) =>
            probe.Last is { } frame && renderer.IsCurrentFrame(frame) && ShowsPhoto(frame, photo);
        bool Ready(PhotoItem photo, DecodedImage? replaced) =>
            !ViewModel.IsDecoding && renderer.DetailSource is { } image
            && !ReferenceEquals(image, replaced) && ShowsPhoto(image, photo) && FrameShows(photo);
        string Persisted(PhotoItem photo) => SidecarStore.Load(photo.FilePath)?.Adjustments.Demosaic ?? Auto;
        async Task<string?> Exported(PhotoItem photo)
        {
            ViewModel.SelectedPhotos = Array.Empty<PhotoItem>();
            var input = (await ViewModel.CaptureExportInputsAsync()).Single();
            Require(string.Equals(Path.GetFullPath(input.SourcePath), Path.GetFullPath(photo.EditPath), StringComparison.OrdinalIgnoreCase),
                $"the export snapshot was taken from {input.SourcePath}, not {photo.FileName}");
            return XmpParser.Parse(input.Xmp)?.Adjustments.Demosaic;
        }
        string Picked() => _demosaicPicker.SelectedItem as string ?? string.Empty;
        void RequireStale(PhotoItem stale, string what)
        {
            Require(!ShowsPhoto(renderer.DetailSource, stale) && !FrameShows(stale),
                $"a late result of {stale.FileName} was published {what} ({State()})");
        }
        async Task RestoreAsync()
        {
            ViewModel.SelectedPhoto = previous;
            ViewModel.SelectedPhotos = originalSelection;
            ViewModel.EnsureDecoded();
            await WaitFor(() => !ViewModel.IsDecoding && renderer.DetailSource != null,
                "the original photo to finish decoding again", failOnDecodeError: false);
            SetMode(originalMode);
            if (originalMode == ShellMode.Edit && _activeGroup != originalGroup)
            {
                if (originalGroup == null) CloseGroupPanel();
                else ToggleGroupPanel(originalGroup);
            }
        }

        ViewModel.PropertyChanged += OnViewModelChanged;
        renderer.GpuFrameReady += probe.Gpu;
        renderer.FrameReady += probe.Cpu;
        try
        {
            RecordSmokeStage(output, "demosaic-open");
            SetMode(ShellMode.Edit);
            ViewModel.SelectedPhotos = Array.Empty<PhotoItem>();
            ViewModel.SelectedPhoto = photoA;
            ViewModel.EnsureDecoded();
            if (_activeGroup != "Detail") ToggleGroupPanel("Detail");
            Content.UpdateLayout();
            await WaitFor(() => Ready(photoA, null), "the first editor frame of the Bayer copy");
            Require(_demosaicPicker.IsEnabled && photoA.CameraSupport?.SensorLayout == "bayer",
                $"the picker is not enabled for the Bayer copy (layout={photoA.CameraSupport?.SensorLayout ?? "unassessed"})");
            Require(ViewModel.Adjustments.Demosaic == Auto && Picked() == Auto, "the fresh copy did not open on Auto");
            var depth = ViewModel.UndoCount;

            RecordSmokeStage(output, "demosaic-select");
            var replaced = renderer.DetailSource;
            _demosaicPicker.SelectedItem = chosen;
            Require(ViewModel.Adjustments.Demosaic == chosen, "the picker selection did not reach the model");
            Require(ViewModel.UndoCount == depth + 1, $"one selection added {ViewModel.UndoCount - depth} undo entries");
            Require(ViewModel.IsDecoding, "the picker selection did not start a re-decode");
            await WaitFor(() => Ready(photoA, replaced), "the re-decoded frame of the chosen kernel");
            await Task.Delay(550);
            Require(ViewModel.UndoCount == depth + 1, "an undo entry was added after the re-decode");
            Require(Picked() == chosen && !RenderErrorBar.IsOpen, "the picker or error bar changed after the re-decode");
            await WaitFor(() => Persisted(photoA) == chosen, "the autosave of the chosen kernel to the sidecar");
            Require(await Exported(photoA) == chosen, "the export snapshot did not carry the chosen kernel");

            RecordSmokeStage(output, "demosaic-undo-redo");
            replaced = renderer.DetailSource;
            ViewModel.Undo();
            Require(ViewModel.Adjustments.Demosaic == Auto && ViewModel.UndoCount == depth, "Undo did not restore the previous kernel");
            Require(Picked() == Auto && ViewModel.IsDecoding, "the picker did not follow Undo into a re-decode");
            await WaitFor(() => Ready(photoA, replaced), "the frame re-decoded after Undo");
            await Task.Delay(550);
            Require(ViewModel.UndoCount == depth, "Undo left a phantom undo entry");
            await WaitFor(() => Persisted(photoA) == Auto, "the sidecar to follow Undo");
            Require(await Exported(photoA) == Auto, "the export snapshot did not follow Undo");
            replaced = renderer.DetailSource;
            ViewModel.Redo();
            Require(ViewModel.Adjustments.Demosaic == chosen && ViewModel.UndoCount == depth + 1, "Redo did not restore the chosen kernel");
            Require(Picked() == chosen && ViewModel.IsDecoding, "the picker did not follow Redo into a re-decode");
            await WaitFor(() => Ready(photoA, replaced), "the frame re-decoded after Redo");
            await WaitFor(() => Persisted(photoA) == chosen, "the sidecar to follow Redo");
            Require(await Exported(photoA) == chosen, "the export snapshot did not follow Redo");

            RecordSmokeStage(output, "demosaic-reopen");
            ViewModel.SelectedPhoto = photoB;
            await WaitFor(() => Ready(photoB, null), "the first frame of the second copy");
            ViewModel.SelectedPhoto = photoA;
            await WaitFor(() => Ready(photoA, null), "the frame of the reopened copy");
            Require(ViewModel.Adjustments.Demosaic == chosen && Picked() == chosen, "the reopened copy lost the chosen kernel");
            Require(Persisted(photoA) == chosen, "the sidecar lost the chosen kernel on reopen");
            Require(await Exported(photoA) == chosen, "the export snapshot lost the chosen kernel on reopen");

            // A 64x64 decode can finish before the next statement runs; the cycles still assert
            // that nothing from the first photo is ever published once the second is selected.
            foreach (var kernel in new[] { nameof(DemosaicChoice.Lmmse), nameof(DemosaicChoice.DualRcd), nameof(DemosaicChoice.Amaze) })
            {
                RecordSmokeStage(output, "demosaic-supersede-" + kernel);
                _demosaicPicker.SelectedItem = kernel;
                Require(ViewModel.Adjustments.Demosaic == kernel && ViewModel.IsDecoding, $"selecting {kernel} did not start a re-decode");
                ViewModel.SelectedPhoto = photoB;
                var deadline = Environment.TickCount64 + 20000;
                while (!Ready(photoB, null) && Environment.TickCount64 < deadline)
                {
                    RequireStale(photoA, "while the second copy was loading");
                    Require(decodeErrors == 0, $"a superseded re-decode reported an error ({State()})");
                    await Task.Delay(5);
                }
                await WaitFor(() => Ready(photoB, null), "the frame of the second copy after a superseded re-decode");
                await Task.Delay(300);
                RequireStale(photoA, "after the second copy was shown");
                Require(!RenderErrorBar.IsOpen && ReferenceEquals(ViewModel.SelectedPhoto, photoB), "the error bar opened or the selection moved after a superseded re-decode");
                await WaitFor(() => Persisted(photoA) == kernel, $"the superseding edit {kernel} to reach the sidecar");
                ViewModel.SelectedPhoto = photoA;
                await WaitFor(() => Ready(photoA, null), "the frame of the first copy after the superseded re-decode");
                Require(ViewModel.Adjustments.Demosaic == kernel && Picked() == kernel, $"the first copy lost {kernel} after being reopened");
            }
            passed = true;
        }
        finally
        {
            try { await RestoreAsync(); }
            catch (Exception error) when (!passed)
            {
                File.AppendAllText(Path.Combine(output, "demosaic-cleanup-error.txt"), error + Environment.NewLine);
            }
            finally
            {
                ViewModel.PropertyChanged -= OnViewModelChanged;
                renderer.GpuFrameReady -= probe.Gpu;
                renderer.FrameReady -= probe.Cpu;
            }
        }

        var hashesAfter = await Task.WhenAll(originals.Select(DemosaicHashAsync));
        if (!hashesBefore.SequenceEqual(hashesAfter))
            throw new InvalidOperationException("Demosaic choice: an original RAW changed during the stage");
        await File.WriteAllTextAsync(evidencePath, JsonSerializer.Serialize(new
            { passed = true, skipped = false, chosen, supersedeCycles = 3, originalsByteIdentical = true }));
        _demosaicChoiceVerified = true;
    }
}
