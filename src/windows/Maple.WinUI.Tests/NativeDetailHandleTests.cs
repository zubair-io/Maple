using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Maple.WinUI.Native;
using Xunit;

namespace Maple.WinUI.Tests;

public class NativeDetailHandleTests
{
    [DemosaicNativeFact]
    public unsafe void NativeHandleReportsSourceGeometryAndReusesMosaicForFiniteDetailTiles()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var path = Environment.GetEnvironmentVariable("MAPLE_DEMOSAIC_TEST_RAW")!;
        var original = SHA256.HashData(File.ReadAllBytes(path));
        using (var handle = RawDetailHandle.Open(path, null))
        {
            Assert.Equal(24, Marshal.SizeOf<MapleRawGeometry>());
            Assert.Equal(0, RawFfi.maple_raw_handle_geometry(handle, out var geometry));
            Assert.True(geometry.CropWidth > 0 && geometry.CropHeight > 0);
            Assert.True((ulong)geometry.CropX + geometry.CropWidth <= geometry.SensorWidth);
            Assert.True((ulong)geometry.CropY + geometry.CropHeight <= geometry.SensorHeight);
            var rejected = new MapleSceneLinearBufferF32();
            Assert.Equal(9, RawFfi.maple_render_handle_scene_linear_tile_ae_f32(handle,
                uint.MaxValue, 0, 2, 2, 2, 2, 0, 0, 0, 1, &rejected));
            Assert.True(rejected.f32_rgba == null);
            var width = Math.Min(32u, geometry.CropWidth);
            var height = Math.Min(32u, geometry.CropHeight);
            foreach (var origin in new[] {
                (geometry.CropX, geometry.CropY),
                (geometry.CropX + geometry.CropWidth - width, geometry.CropY + geometry.CropHeight - height) })
            {
                var buffer = new MapleSceneLinearBufferF32();
                try
                {
                    var rc = RawFfi.maple_render_handle_scene_linear_tile_ae_f32(handle,
                        origin.Item1, origin.Item2, width, height, width, height, 0, 0, 0, 1, &buffer);
                    Assert.True(rc == 0, RawFfi.LastError());
                    Assert.Equal(width, buffer.width);
                    Assert.Equal(height, buffer.height);
                    Assert.Equal((nuint)(width * height * 16), buffer.len_bytes);
                    foreach (var value in new ReadOnlySpan<float>(buffer.f32_rgba, checked((int)(width * height * 4))))
                        Assert.True(float.IsFinite(value));
                }
                finally { RawFfi.maple_free_scene_linear_buffer_f32(&buffer); }
            }
        }
        Assert.Equal(original, SHA256.HashData(File.ReadAllBytes(path)));
    }

    [DemosaicNativeFact]
    public void FailedOpenDoesNotProduceAnOwnedHandle()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        Assert.Throws<InvalidDataException>(() => RawDetailHandle.Open(
            Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.dng"), null));
    }
}
