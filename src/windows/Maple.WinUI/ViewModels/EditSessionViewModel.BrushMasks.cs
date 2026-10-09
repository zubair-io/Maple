using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        private readonly List<uint> _brushRasterIds = new();

        private void RegisterBrushRastersAndPublish(int generation, PhotoItem photo, DecodedImage decoded, AdjustmentState model)
        {
            var registered = model.LocalAdjustments
                .Select(layer => layer.Mask is BrushMask brush
                    ? (layer, mask: BrushMaskRasterizer.Register(brush, decoded.Width, decoded.Height))
                    : (layer, mask: (BrushMask?)null))
                .Where(x => x.mask != null).ToList();
            OnUi(() =>
            {
                if (_disposed || generation != _decodeGeneration)
                {
                    foreach (var entry in registered)
                        if (entry.mask is { } stale) RawFfi.maple_mask_raster_release(stale.RasterId);
                    return;
                }
                foreach (var entry in registered)
                {
                    var digest = ((BrushMask)entry.layer.Mask).Digest;
                    var index = Adjustments.LocalAdjustments.FindIndex(x => x.Mask is BrushMask b && b.Digest == digest);
                    if (index < 0 || entry.mask == null) continue;
                    Adjustments.LocalAdjustments[index] = Adjustments.LocalAdjustments[index] with { Mask = entry.mask };
                    _brushRasterIds.Add(entry.mask.RasterId);
                }
                Renderer.SetImage(decoded, () => !_disposed && generation == System.Threading.Volatile.Read(ref _decodeGeneration));
                ApplyDecodedState(generation, photo, decoded);
            });
        }

        private void ReleaseBrushRasters()
        {
            foreach (var id in _brushRasterIds) RawFfi.maple_mask_raster_release(id);
            _brushRasterIds.Clear();
        }
    }
}
