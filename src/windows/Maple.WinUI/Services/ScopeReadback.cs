using System;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services;

public sealed record ScopePanelFrame(long Version, double[] Values, uint[] ChromaBins);

/// <summary>One worker's bounded reusable native output buffers. Never shared
/// across the CPU render worker and GPU poll worker.</summary>
public sealed unsafe class ScopeReadback
{
    private readonly uint[] _bins = new uint[128 * 128];
    private readonly byte[] _rgb = new byte[512 * 512 * 3];
    private uint _width, _height;

    public int Poll(MapleGpuLiveSession* session, out ulong frame)
    {
        fixed (uint* bins = _bins)
        fixed (byte* rgb = _rgb)
        {
            var stats = Output(bins, rgb);
            var rc = RawFfi.maple_gpu_live_poll_scope(session, &stats);
            frame = stats.frame;
            if (rc == 1) { _width = stats.snapshot_width; _height = stats.snapshot_height; }
            return rc;
        }
    }

    public void FromCpu(float[] encoded, int width, int height)
    {
        if (width <= 0 || height <= 0 || (long)width * height * 4 > encoded.Length)
            throw new ArgumentException("CPU scope buffer does not contain the declared image.");
        fixed (uint* bins = _bins)
        fixed (byte* rgb = _rgb)
        fixed (float* pixels = encoded)
        {
            var stats = Output(bins, rgb);
            var rc = RawFfi.maple_scope_from_display_f32(pixels, (nuint)(width * (long)height * 4),
                (uint)width, (uint)height, &stats);
            if (rc != 0) throw new InvalidOperationException($"CPU scope failed ({rc}): {RawFfi.LastError()}");
            _width = stats.snapshot_width; _height = stats.snapshot_height;
        }
    }

    public ScopePanelFrame Reduce(long version)
    {
        var values = new double[448];
        fixed (byte* rgb = _rgb)
        fixed (double* result = values)
        {
            var rc = RawFfi.maple_scope_panel_reduce(rgb, _width * _height * 3, _width, _height, result, 448);
            if (rc != 0) throw new InvalidOperationException($"Scope reduction failed ({rc}): {RawFfi.LastError()}");
        }
        return new(version, values, (uint[])_bins.Clone());
    }

    private MapleScopeStats Output(uint* bins, byte* rgb) => new()
    {
        bins_ptr = bins, bins_len = (uint)_bins.Length,
        snapshot_ptr = rgb, snapshot_len = (uint)_rgb.Length,
    };
}
