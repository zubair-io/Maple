using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Text.Json;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services;

public readonly record struct WhiteBalanceBaseline(double Temperature, double Tint)
{
    public bool IsValid => double.IsFinite(Temperature) && Temperature > 0 && double.IsFinite(Tint);
    public WhiteBalanceBaseline Snap() => new(Math.Round(Temperature / 50, MidpointRounding.AwayFromZero) * 50,
        Math.Round(Tint, MidpointRounding.AwayFromZero));
}

/// <summary>Frozen clipboard source for #3880. The source photo can change after copying.</summary>
public sealed class AdjustmentTransferSource
{
    private readonly AdjustmentState _state;
    public int WhiteBalanceScaleVersion { get; }
    public WhiteBalanceBaseline? Baseline { get; }
    public AdjustmentTransferSource(AdjustmentState state, int scaleVersion, WhiteBalanceBaseline? baseline)
    { _state = state.Clone(); WhiteBalanceScaleVersion = scaleVersion; Baseline = baseline; }
    internal AdjustmentState Snapshot() => _state.Clone();
}

public sealed record AdjustmentTransferPatch(IReadOnlyDictionary<string, JsonElement> Fields,
    int? WhiteBalanceScaleVersion, IReadOnlyList<string> Excluded);

/// <summary>Dense group transfer and target-specific camera corrections. Staged under
/// #3880; the durable runner and production selective-paste UI consume this contract.</summary>
public static class AdjustmentTransfer
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly Dictionary<string, AdjustmentFieldSpec> Specs = AdjustmentFields.All.ToDictionary(f => f.Name);

    public static AdjustmentTransferPatch Build(AdjustmentTransferSource clipboard, IEnumerable<string> groupIds,
        bool relativeWhiteBalance = false, WhiteBalanceBaseline? targetBaseline = null)
    {
        var selected = groupIds.ToHashSet(StringComparer.Ordinal);
        if (selected.Any(id => !AdjustmentFields.Groups.Any(g => g.Id == id)))
            throw new InvalidDataException("The selected adjustment group is unsupported.");
        var names = AdjustmentFields.Groups.Where(g => selected.Contains(g.Id)).SelectMany(g => g.Fields)
            .ToHashSet(StringComparer.Ordinal);
        var excluded = names.Where(n => Mode(n) == "Unsupported").ToArray();
        names.ExceptWith(excluded);
        var source = clipboard.Snapshot();
        var fields = AdjustmentFieldBridge.CaptureFields(source, names);
        foreach (var name in names)
        {
            if (Specs.TryGetValue(name, out var spec) && spec.Kind == "Curve" && Mode(name) == "Absolute")
                fields[name] = JsonSerializer.SerializeToElement(typeof(AdjustmentState).GetField(spec.Member)!.GetValue(source), Json);
            else if (name == "crop" && Mode(name) == "AssetRelative")
                fields[name] = JsonSerializer.SerializeToElement(source.Crop, Json);
            else if (!fields.ContainsKey(name) && name != "wb_scale_version")
                throw new InvalidDataException($"No Windows transfer implementation for {name}.");
        }
        int? scale = null;
        if (selected.Contains("white_balance"))
        {
            scale = clipboard.WhiteBalanceScaleVersion;
            fields["white_balance_preset"] = JsonSerializer.SerializeToElement(source.WhiteBalancePreset);
            // A copied sample has no valid position/algorithm on another image.
            fields["wb_sample_x"] = JsonSerializer.SerializeToElement(0);
            fields["wb_sample_y"] = JsonSerializer.SerializeToElement(0);
            fields["wb_algorithm_version"] = JsonSerializer.SerializeToElement(0);
            if (relativeWhiteBalance)
            {
                var correction = Correction(clipboard);
                if (targetBaseline is not { IsValid: true } baseline)
                    throw new InvalidDataException("Cannot read this photo's camera As Shot white balance.");
                SetRelative(fields, "temperature", baseline.Temperature + correction.Temperature);
                SetRelative(fields, "tint", baseline.Tint + correction.Tint);
                fields["white_balance_preset"] = JsonSerializer.SerializeToElement(WhiteBalancePresets.Custom);
                fields["wb_source"] = JsonSerializer.SerializeToElement(nameof(WbSource.Manual));
                scale = AdjustmentFields.CurrentWhiteBalanceScaleVersion;
            }
        }
        // Validate before the patch can enter a preview or durable ledger.
        var patch = new AdjustmentTransferPatch(new ReadOnlyDictionary<string, JsonElement>(fields), scale, Array.AsReadOnly(excluded));
        Apply(new XmpSidecarDocument(), patch);
        return patch;
    }

    public static WhiteBalanceBaseline Correction(AdjustmentTransferSource clipboard)
    {
        if (clipboard.WhiteBalanceScaleVersion != AdjustmentFields.CurrentWhiteBalanceScaleVersion)
            throw new InvalidDataException("Relative white balance requires a current-scale source. Reapply its white balance first.");
        if (clipboard.Baseline is not { IsValid: true } baseline)
            throw new InvalidDataException("Cannot read source camera As Shot white balance. Use absolute white balance or retry.");
        var source = clipboard.Snapshot();
        if (source.WbSource == WbSource.AsShot || source.WhiteBalancePreset == WhiteBalancePresets.AsShot) return new(0, 0);
        var correction = new WhiteBalanceBaseline(source.Temperature - baseline.Temperature, source.Tint - baseline.Tint);
        if (!double.IsFinite(correction.Temperature) || !double.IsFinite(correction.Tint))
            throw new InvalidDataException("The source white balance is invalid.");
        return correction;
    }

    /// <summary>Modify only the supplied document after all fields validate. Passthrough
    /// content, target masks/repairs and culling metadata stay attached to that document.</summary>
    public static void Apply(XmpSidecarDocument target, AdjustmentTransferPatch patch)
    {
        var scalar = patch.Fields.Where(p => Specs.TryGetValue(p.Key, out var spec)
            && spec.Kind != "Curve" && spec.Copyable && Mode(p.Key) != "Unsupported")
            .ToDictionary(p => p.Key, p => p.Value);
        var applied = AdjustmentFieldBridge.Apply(target.Adjustments, scalar);
        if (applied.Skipped.Length != 0) throw new InvalidDataException("Unsupported transfer values: " + string.Join(", ", applied.Skipped));
        var state = applied.State;
        foreach (var (name, value) in patch.Fields)
        {
            if (scalar.ContainsKey(name)) continue;
            if (Specs.TryGetValue(name, out var spec) && spec.Kind == "Curve" && Mode(name) == "Absolute")
            {
                var points = value.Deserialize<List<CurvePoint>>(Json) ?? throw new InvalidDataException("Invalid curve.");
                if (points.Any(p => !double.IsFinite(p.X) || !double.IsFinite(p.Y) || p.X < 0 || p.X > 1 || p.Y < 0 || p.Y > 1))
                    throw new InvalidDataException("Curve points must be finite and normalized.");
                typeof(AdjustmentState).GetField(spec.Member)!.SetValue(state, points);
            }
            else if (name == "crop" && Mode(name) == "AssetRelative")
            {
                var crop = value.Deserialize<CropState>(Json);
                if (!double.IsFinite(crop.Angle) || !double.IsFinite(crop.Top) || !double.IsFinite(crop.Left)
                    || !double.IsFinite(crop.Bottom) || !double.IsFinite(crop.Right) || crop.Top < 0 || crop.Left < 0
                    || crop.Bottom > 1 || crop.Right > 1 || crop.Top >= crop.Bottom || crop.Left >= crop.Right)
                    throw new InvalidDataException("Crop must be a finite normalized rectangle.");
                state.Crop = crop;
            }
            else if (patch.WhiteBalanceScaleVersion.HasValue && name == "white_balance_preset" && value.ValueKind == JsonValueKind.String)
                state.WhiteBalancePreset = value.GetString()!;
            else if (patch.WhiteBalanceScaleVersion.HasValue && name is "wb_sample_x" or "wb_sample_y" or "wb_algorithm_version"
                && value.ValueKind == JsonValueKind.Number && value.GetDouble() == 0)
                typeof(AdjustmentState).GetField(Specs[name].Member)!.SetValue(state, 0d);
            else throw new InvalidDataException($"Unsupported transfer field {name}.");
        }
        if (patch.WhiteBalanceScaleVersion is { } scale && scale != 1 && scale != AdjustmentFields.CurrentWhiteBalanceScaleVersion)
            throw new InvalidDataException("Unsupported white balance scale.");
        target.Adjustments = state;
        if (patch.WhiteBalanceScaleVersion is { } version) target.WbScaleVersion = version;
    }

    private static string Mode(string field) => AdjustmentFields.TransferModes.TryGetValue(field, out var mode)
        ? mode : throw new InvalidDataException($"No transfer decision for {field}.");

    private static void SetRelative(Dictionary<string, JsonElement> fields, string name, double value)
    {
        if (Mode(name) != "Relative") throw new InvalidDataException($"Relative transfer is not supported for {name}.");
        var spec = Specs[name];
        fields[name] = JsonSerializer.SerializeToElement(Math.Clamp(value, spec.Minimum, spec.Maximum));
    }
}
