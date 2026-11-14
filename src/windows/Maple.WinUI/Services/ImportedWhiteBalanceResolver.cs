using System;
using System.Threading;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services;

/// <summary>Cold import hydration through the shared Rust resolver (#3434/#4669).
/// Partial pairs resolve before the first decode; name-only Auto resolves after the
/// As Shot first frame. The owning open generation guards publication; ticks reuse
/// the resolved pair.</summary>
public static unsafe class ImportedWhiteBalanceResolver
{
    /// <summary>Name-only imported Auto that the opened RAW has not resolved yet:
    /// it renders As Shot until the background estimate lands (#4669).</summary>
    public static bool IsUnresolvedAuto(AdjustmentState model) =>
        model.ImportedWhiteBalance is { Temperature: null, Tint: null, Resolved: null };

    /// <summary>A cancelled <paramref name="cancellation"/> stops a running estimate inside
    /// the native call (#5922) and throws <see cref="OperationCanceledException"/> with the
    /// model untouched.</summary>
    public static void ResolveInPlace(
        string rawPath, AdjustmentState model, CancellationToken cancellation = default)
    {
        if (model.ImportedWhiteBalance is not { } imported) return;
        if (imported.Resolved is not { } pair)
        {
            var xml = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = model });
            var values = stackalloc float[2];
            var source = WhiteBalanceSampler.IsRawPath(rawPath) ? rawPath : null;
            var rc = Resolve(source, xml, values, cancellation);
            if (rc == CancelledReturnCode) throw new OperationCanceledException(cancellation);
            if (rc != 0)
                throw new InvalidOperationException($"Imported white balance: {RawFfi.LastError()}");
            pair = new ResolvedWhiteBalance(values[0], values[1]);
            model.ImportedWhiteBalance = imported with { Resolved = pair };
        }
        model.Temperature = pair.Temperature;
        model.Tint = pair.Tint;
        model.WhiteBalanceScaleVersion = 5;
        if (imported is { Temperature: null, Tint: null })
        {
            model.WbSource = WbSource.Auto;
            model.WbAlgorithmVersion = WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion;
        }
    }

    /// <summary><c>maple_resolve_imported_white_balance_file</c>'s cancelled return code.</summary>
    private const int CancelledReturnCode = 4;

    /// <summary>The native flag lives for the whole call; the registration is disposed, which
    /// waits out a running set, before the flag is freed.</summary>
    private static int Resolve(string? source, string xml, float* values, CancellationToken cancellation)
    {
        if (!cancellation.CanBeCanceled)
            return RawFfi.maple_resolve_imported_white_balance_file(source, xml, IntPtr.Zero, values);
        var flag = RawFfi.maple_cancel_flag_new();
        try
        {
            using (cancellation.Register(() => RawFfi.maple_cancel_flag_set(flag)))
                return RawFfi.maple_resolve_imported_white_balance_file(source, xml, flag, values);
        }
        finally
        {
            RawFfi.maple_cancel_flag_free(flag);
        }
    }

    /// <summary>Hydrate only the same imported intent. A manual WB edit made
    /// while the decode ran has cleared that intent and remains authoritative.
    /// True when <paramref name="target"/> took a pair it did not hold yet.</summary>
    public static bool ApplyResolved(AdjustmentState target, AdjustmentState source)
    {
        if (target.ImportedWhiteBalance is not { } current
            || source.ImportedWhiteBalance is not { Resolved: { } pair } resolved
            || current.Temperature != resolved.Temperature || current.Tint != resolved.Tint
            || current.Version != resolved.Version) return false;
        target.ImportedWhiteBalance = resolved;
        target.Temperature = pair.Temperature;
        target.Tint = pair.Tint;
        target.WhiteBalanceScaleVersion = 5;
        if (resolved is { Temperature: null, Tint: null })
        {
            target.WbSource = WbSource.Auto;
            target.WbAlgorithmVersion = WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion;
        }
        return current.Resolved != pair;
    }

    /// <summary>A final derivative (sidecar thumbnail, persisted preview) has no first
    /// frame to protect: imported WB resolves on its RAW, never As Shot (#4669), and
    /// only an untouched model takes the decode's As Shot pair.</summary>
    public static void PrepareDerivative(string rawPath, AdjustmentState model, DecodedImage image)
    {
        ResolveInPlace(rawPath, model);
        if (model.Temperature == 6500 && model.Tint == 0 && image.DecodedTemperature > 0)
        {
            model.Temperature = image.DecodedTemperature;
            model.Tint = image.DecodedTint;
        }
    }
}
