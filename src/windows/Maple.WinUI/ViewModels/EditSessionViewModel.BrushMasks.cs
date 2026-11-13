using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        private readonly List<uint> _brushRasterIds = new();

        private void SetBrushCorrectionDiscardPath(string? path)
        {
            _discardBrushCorrectionsForPhotoPath = path;
            _brushDiscardGeneration++;
        }

        private bool ShouldDiscardBrushCorrectionsFor(string photoPath) =>
            _discardBrushCorrectionsForPhotoPath is { } path &&
            string.Equals(path, photoPath, StringComparison.OrdinalIgnoreCase) &&
            !Adjustments.LocalAdjustments.Any(layer => layer.Mask is BrushMask);

        private BrushCorrectionRestoreSnapshot? BrushCorrectionsToRestoreFor(string photoPath, AdjustmentState model) =>
            model.LocalAdjustments.Any(layer => layer.Mask is BrushMask) &&
            _brushCorrectionsRemovedByReset.TryGetValue(photoPath, out var containers)
                ? containers
                : null;

        private readonly record struct RegisteredBrush(int Index, string Digest, BrushMask? Mask);

        private List<RegisteredBrush> RegisterBrushRasters(AdjustmentState model, int width, int height)
        {
            var registered = new List<RegisteredBrush>();
            try
            {
                for (var i = 0; i < model.LocalAdjustments.Count; i++)
                {
                    if (model.LocalAdjustments[i].Mask is not BrushMask brush) continue;
                    registered.Add(new RegisteredBrush(i, brush.Digest,
                        BrushMaskRasterizer.Register(brush with { RasterId = 0 }, width, height)));
                }
                return registered;
            }
            catch
            {
                ReleaseRegisteredBrushes(registered);
                throw;
            }
        }

        private bool ApplyBrushRasters(AdjustmentState model, IReadOnlyList<RegisteredBrush> registered)
        {
            var complete = true;
            foreach (var entry in registered)
            {
                if (entry.Mask == null) { complete = false; continue; }
                if (entry.Index >= model.LocalAdjustments.Count ||
                    model.LocalAdjustments[entry.Index].Mask is not BrushMask current || current.Digest != entry.Digest)
                {
                    RawFfi.maple_mask_raster_release(entry.Mask.RasterId);
                    continue;
                }
                model.LocalAdjustments[entry.Index] = model.LocalAdjustments[entry.Index] with { Mask = entry.Mask };
                if (current.RasterId != 0 &&
                    current.RasterId != entry.Mask.RasterId &&
                    _brushRasterIds.Remove(current.RasterId))
                {
                    RawFfi.maple_mask_raster_release(current.RasterId);
                }
                _brushRasterIds.Add(entry.Mask.RasterId);
            }
            return complete;
        }

        private void RegisterBrushRastersAndPublish(int generation, PhotoItem photo, DecodedImage decoded, AdjustmentState model)
        {
            var registered = RegisterBrushRasters(model, decoded.Width, decoded.Height);
            Renderer.SetImage(decoded, () => !_disposed && System.Threading.Volatile.Read(ref _decodeGeneration) == generation);
            OnUi(() =>
            {
                if (_disposed || generation != _decodeGeneration)
                {
                    foreach (var entry in registered)
                        if (entry.Mask is { } stale) RawFfi.maple_mask_raster_release(stale.RasterId);
                    return;
                }
                ApplyBrushRasters(Adjustments, registered);
                _decodedImageSize = (decoded.Width, decoded.Height);
                ApplyDecodedState(generation, photo, decoded);
                ScheduleAmazeUpgrade(generation, photo, model, decoded);
            });
        }

        private void ReleaseBrushRasters()
        {
            for (var i = 0; i < Adjustments.LocalAdjustments.Count; i++)
                if (Adjustments.LocalAdjustments[i].Mask is BrushMask mask && _brushRasterIds.Contains(mask.RasterId))
                    Adjustments.LocalAdjustments[i] = Adjustments.LocalAdjustments[i] with { Mask = mask with { RasterId = 0 } };
            foreach (var id in _brushRasterIds) RawFfi.maple_mask_raster_release(id);
            _brushRasterIds.Clear();
        }

        private void RehydrateCurrentBrushRasters(AdjustmentState model, Action? completion = null)
        {
            if (_decodedImageSize is not { } size)
            {
                completion?.Invoke();
                return;
            }

            var generation = Volatile.Read(ref _decodeGeneration);
            var snapshot = model.Clone();
            _ = Task.Run(() => RegisterBrushRasters(snapshot, size.Width, size.Height))
                .ContinueWith(task => OnUi(() =>
                {
                    if (_disposed || generation != _decodeGeneration || !ReferenceEquals(model, Adjustments))
                    {
                        if (task.IsCompletedSuccessfully) ReleaseRegisteredBrushes(task.Result);
                        return;
                    }
                    if (task.IsCompletedSuccessfully)
                        ApplyBrushRasters(model, task.Result);
                    else
                        DiagLog.Write($"[brush] rehydrate failed: {task.Exception?.GetBaseException().Message}");
                    completion?.Invoke();
                }), TaskScheduler.Default);
        }

        private static void ReleaseRegisteredBrushes(IEnumerable<RegisteredBrush> registered)
        {
            foreach (var entry in registered)
                if (entry.Mask is { } mask) RawFfi.maple_mask_raster_release(mask.RasterId);
        }
    }
}
