using System;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

/// <summary>
/// Repair decode-frame fractions ↔ oriented, perspective-corrected fractions.
/// The WinUI CropRotateHost supplies crop/straighten/zoom/pan transforms outside
/// this map. Geometry mirrors raw-core/stages/perspective/matrix.rs, not a
/// second image-processing implementation.
/// </summary>
public sealed class RepairCanvasMap
{
    private readonly int _orientation;
    private readonly double _aspect, _kh, _kv, _sin, _cos, _stretch, _scale, _x, _y;
    public double FrameAspect => _orientation >= 5 ? 1 / _aspect : _aspect;

    public RepairCanvasMap(int orientation, double orientedAspect, AdjustmentState state)
    {
        if (orientation is < 1 or > 8 || !double.IsFinite(orientedAspect) || orientedAspect <= 0)
            throw new ArgumentOutOfRangeException(nameof(orientation));
        _orientation = orientation;
        _aspect = orientedAspect;
        _kh = .5 * state.PerspectiveHorizontal / 100;
        _kv = .5 * state.PerspectiveVertical / 100;
        _sin = Math.Sin(state.PerspectiveRotate * Math.PI / 180);
        _cos = Math.Cos(state.PerspectiveRotate * Math.PI / 180);
        _stretch = Math.Pow(1.5, state.PerspectiveAspect / 100);
        _scale = state.PerspectiveScale / 100;
        _x = state.PerspectiveX / 100;
        _y = state.PerspectiveY / 100;
    }

    public MaskPoint? ToDisplay(MaskPoint frame)
    {
        var oriented = Orient(frame, _orientation);
        var x = oriented.X * 2 - 1;
        var y = oriented.Y * 2 - 1;
        var w = 1 + _kh * x + _kv * y;
        if (Math.Abs(w) < 1e-6 || Math.Abs(_scale) < 1e-9) return null;
        x /= w; y /= w;
        var rx = _cos * x - _sin * y / _aspect;
        var ry = _sin * x * _aspect + _cos * y;
        return Finite(new((rx * _stretch * _scale + _x + 1) / 2,
            (ry / _stretch * _scale + _y + 1) / 2));
    }

    public MaskPoint? ToFrame(MaskPoint display)
    {
        if (Math.Abs(_scale) < 1e-9 || !double.IsFinite(_stretch) || _stretch <= 0) return null;
        var x = (display.X * 2 - 1 - _x) / _scale / _stretch;
        var y = (display.Y * 2 - 1 - _y) / _scale * _stretch;
        var rx = _cos * x + _sin * y / _aspect;
        var ry = -_sin * x * _aspect + _cos * y;
        var w = 1 - _kh * rx - _kv * ry;
        if (Math.Abs(w) < 1e-6) return null;
        var oriented = new MaskPoint((rx / w + 1) / 2, (ry / w + 1) / 2);
        return Finite(Orient(oriented, _orientation switch { 6 => 8, 8 => 6, _ => _orientation }));
    }

    public static MaskPoint Orient(MaskPoint p, int orientation) => orientation switch
    {
        1 => p,
        2 => new(1 - p.X, p.Y),
        3 => new(1 - p.X, 1 - p.Y),
        4 => new(p.X, 1 - p.Y),
        5 => new(p.Y, p.X),
        6 => new(1 - p.Y, p.X),
        7 => new(1 - p.Y, 1 - p.X),
        8 => new(p.Y, 1 - p.X),
        _ => throw new ArgumentOutOfRangeException(nameof(orientation)),
    };

    private static MaskPoint? Finite(MaskPoint p) => double.IsFinite(p.X) && double.IsFinite(p.Y) ? p : null;
}
