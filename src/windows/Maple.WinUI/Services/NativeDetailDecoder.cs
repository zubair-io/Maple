using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services;

public readonly record struct NativeDetailRegion(uint X, uint Y, uint Width, uint Height);
public sealed record NativeDetailImage(NativeDetailRegion Region, MapleRawGeometry Geometry, DecodedImage Image);

// #3876: retained mosaic and bounded scene-linear patches; viewport composition is tracked separately in the issue.
public sealed class NativeDetailDecoder : IAsyncDisposable
{
    public const ulong MaximumPatchPixels = 16 * 1024 * 1024;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private RawDetailHandle? _handle;
    private (string Path, long Modified, long Length, string Model)? _key;
    private MapleRawGeometry _geometry;
    private int _disposed;

    public Task<MapleRawGeometry> ReadGeometryAsync(string path, AdjustmentState model, CancellationToken cancellation) =>
        RunAsync(path, model, cancellation, () => _geometry);

    public Task<NativeDetailImage> DecodeAsync(string path, AdjustmentState model, DecodedImage anchor,
        NativeDetailRegion region, CancellationToken cancellation) =>
        RunAsync(path, model, cancellation, () => DecodeRegion(anchor, region));

    private async Task<T> RunAsync<T>(string path, AdjustmentState model, CancellationToken cancellation, Func<T> operation)
    {
        var snapshot = RenderEngine.StripChainStages(model);
        var xmp = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = snapshot });
        await _gate.WaitAsync(cancellation).ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
            return await Task.Run(() =>
            {
                cancellation.ThrowIfCancellationRequested();
                EnsureHandle(path, snapshot, xmp);
                cancellation.ThrowIfCancellationRequested();
                var result = operation();
                cancellation.ThrowIfCancellationRequested();
                ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
                return result;
            }, cancellation).ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }

    private void EnsureHandle(string path, AdjustmentState model, string xmp)
    {
        path = Path.GetFullPath(path);
        var file = new FileInfo(path);
        var key = (path, file.LastWriteTimeUtc.Ticks, file.Length, xmp);
        if (_handle != null && _key == key) return;
        _handle?.Dispose();
        _handle = null;
        _key = null;
        LensProfileStore.RestoreForFile(path, model);
        var sidecar = Path.Combine(Path.GetTempPath(), $"maple-detail-{Guid.NewGuid():N}.xmp");
        try
        {
            File.WriteAllText(sidecar, xmp);
            var opened = RawDetailHandle.Open(path, sidecar);
            try
            {
                var rc = RawFfi.maple_raw_handle_geometry(opened, out var geometry);
                if (rc != 0) throw new InvalidDataException($"Native source geometry failed ({rc}): {RawFfi.LastError()}");
                _geometry = geometry;
                _handle = opened;
                _key = key;
            }
            catch { opened.Dispose(); throw; }
        }
        finally { try { File.Delete(sidecar); } catch (IOException) { } }
    }

    private unsafe NativeDetailImage DecodeRegion(DecodedImage anchor, NativeDetailRegion region)
    {
        if (region.Width == 0 || region.Height == 0
            || region.X >= _geometry.CropWidth || region.Y >= _geometry.CropHeight
            || region.Width > _geometry.CropWidth - region.X || region.Height > _geometry.CropHeight - region.Y
            || region.Width > 16384 || region.Height > 16384
            || (ulong)region.Width * region.Height > MaximumPatchPixels)
            throw new ArgumentOutOfRangeException(nameof(region), "Native detail patch exceeds the source or memory bounds.");
        var buffer = new MapleSceneLinearBufferF32();
        try
        {
            var rc = RawFfi.maple_render_handle_scene_linear_tile_ae_f32(_handle!,
                _geometry.CropX + region.X, _geometry.CropY + region.Y,
                region.Width, region.Height, region.Width, region.Height, 0, 0, 0, anchor.AeGain, &buffer);
            if (rc != 0) throw new InvalidDataException($"Native detail unavailable ({rc}): {RawFfi.LastError()}");
            if (buffer.width != region.Width || buffer.height != region.Height || buffer.channels != 4
                || buffer.bytes_per_pixel != 16 || buffer.len_bytes != (nuint)((ulong)region.Width * region.Height * 16)
                || buffer.f32_rgba == null)
                throw new InvalidDataException("Native detail returned unexpected buffer geometry.");
            var image = new DecodedImage
            {
                Pixels = new ReadOnlySpan<float>(buffer.f32_rgba, checked((int)(region.Width * region.Height * 4))).ToArray(),
                Width = (int)region.Width, Height = (int)region.Height,
                NoiseProfile = anchor.NoiseProfile, Iso = anchor.Iso,
                AeGain = anchor.AeGain, WhitesAnchorEv = anchor.WhitesAnchorEv,
                DecodedTemperature = anchor.DecodedTemperature, DecodedTint = anchor.DecodedTint,
                WbFrame = anchor.WbFrame, CameraSupport = anchor.CameraSupport, LensProfile = anchor.LensProfile,
                ProfileCurve = anchor.ProfileCurve, ResidualLut = anchor.ResidualLut, ResidualLutSize = anchor.ResidualLutSize,
                DisplayLut = anchor.DisplayLut, DisplayLutN = anchor.DisplayLutN,
            };
            return new NativeDetailImage(region, _geometry, image);
        }
        finally { RawFfi.maple_free_scene_linear_buffer_f32(&buffer); }
    }

    public async ValueTask DisposeAsync()
    {
        Interlocked.Exchange(ref _disposed, 1);
        await _gate.WaitAsync().ConfigureAwait(false);
        try { _handle?.Dispose(); _handle = null; _key = null; }
        finally { _gate.Release(); }
    }

}
