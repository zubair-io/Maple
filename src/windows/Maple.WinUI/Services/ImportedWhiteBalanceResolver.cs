using System;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services;

/// <summary>Cold import hydration through the shared Rust resolver (#4669).
/// The owning open generation guards publication; ticks reuse the resolved pair.</summary>
public static unsafe class ImportedWhiteBalanceResolver
{
    public static void ResolveInPlace(string rawPath, AdjustmentState model)
    {
        if (model.ImportedWhiteBalance is not { } imported) return;
        if (imported.Resolved is not { } pair)
        {
            var xml = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = model });
            var values = stackalloc float[2];
            var source = WhiteBalanceSampler.IsRawPath(rawPath) ? rawPath : null;
            var rc = RawFfi.maple_resolve_imported_white_balance_file(source, xml, values);
            if (rc != 0)
                throw new InvalidOperationException($"Imported white balance: {RawFfi.LastError()}");
            pair = new ResolvedWhiteBalance(values[0], values[1]);
            model.ImportedWhiteBalance = imported with { Resolved = pair };
        }
        model.Temperature = pair.Temperature;
        model.Tint = pair.Tint;
        model.WhiteBalanceScaleVersion = 5;
    }

    /// <summary>Hydrate only the same imported intent. A manual WB edit made
    /// while the decode ran has cleared that intent and remains authoritative.</summary>
    public static void ApplyResolved(AdjustmentState target, AdjustmentState source)
    {
        if (target.ImportedWhiteBalance is not { } current
            || source.ImportedWhiteBalance is not { Resolved: { } pair } resolved
            || current.Temperature != resolved.Temperature || current.Tint != resolved.Tint
            || current.Version != resolved.Version) return;
        target.ImportedWhiteBalance = resolved;
        target.Temperature = pair.Temperature;
        target.Tint = pair.Tint;
        target.WhiteBalanceScaleVersion = 5;
    }
}
