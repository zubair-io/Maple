using System.Collections.Generic;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        private readonly List<uint> _brushRasterIds = new();

        private readonly record struct RegisteredBrush(int Index, string Digest, BrushMask? Mask);

        private List<RegisteredBrush> RegisterBrushRasters(AdjustmentState model, int width, int height)
        {
            var registered = new List<RegisteredBrush>();
            for (var i = 0; i < model.LocalAdjustments.Count; i++)
            {
                if (model.LocalAdjustments[i].Mask is not BrushMask { RasterId: 0 } brush) continue;
                registered.Add(new RegisteredBrush(i, brush.Digest,
                    BrushMaskRasterizer.Register(brush, width, height)));
            }
            return registered;
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
                _decodedImage = decoded;
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

        private void RehydrateCurrentBrushRasters(AdjustmentState model)
        {
            if (_decodedImage is null) return;
            ApplyBrushRasters(model, RegisterBrushRasters(model, _decodedImage.Width, _decodedImage.Height));
        }
    }
}
