using System;
using System.Linq;
using System.Text;
using Maple.WinUI.Models;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    internal static unsafe class BrushMaskRasterizer
    {
        public static BrushMask? Register(BrushMask mask, int imageWidth, int imageHeight)
        {
            if (mask.RasterId != 0) return mask;
            var width = imageWidth >= imageHeight ? 1024 : Math.Max(1, imageWidth * 1024 / imageHeight);
            var height = imageHeight >= imageWidth ? 1024 : Math.Max(1, imageHeight * 1024 / imageWidth);
            var dabs = mask.Dabs.SelectMany(d => new[] {(float)d.Center.X,(float)d.Center.Y,(float)d.Radius,(float)d.Feather,(float)d.Weight,d.Erase ? 1f : 0f}).ToArray();
            var raster = new byte[checked(width * height)];
            fixed (float* dabPtr = dabs)
            fixed (byte* rasterPtr = raster)
            {
                var rc = RawFfi.maple_brush_rasterize(dabPtr, (nuint)(dabs.Length / 6), (uint)width, (uint)height, rasterPtr, (nuint)raster.Length);
                if (rc != 0) return null;
                var digest = Encoding.ASCII.GetBytes(mask.Digest);
                if (digest.Length != 16 || mask.Digest.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))) return null;
                fixed (byte* digestPtr = digest)
                {
                    var id = RawFfi.maple_mask_raster_register(digestPtr, (uint)width, (uint)height, rasterPtr, (nuint)raster.Length);
                    return id > 0 ? mask with { RasterId = (uint)id } : null;
                }
            }
        }
    }
}
