using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

public sealed record SparseAdjustmentResult(AdjustmentState State, string[] Applied, string[] Skipped);

/// <summary>One canonical mapping for presets and semantic transfer (#3879/#3880).
/// Ranges, exclusions and transfer modes come from raw-core, not UI key lists.</summary>
public static class AdjustmentFieldBridge
{
    private static readonly Dictionary<string, AdjustmentFieldSpec> Specs = AdjustmentFields.All.ToDictionary(f => f.Name, StringComparer.Ordinal);
    private static readonly Dictionary<string, FieldInfo> Members = AdjustmentFields.All
        .Select(f => (f.Name, Member: typeof(AdjustmentState).GetField(f.Member)))
        .Where(f => f.Member != null).ToDictionary(f => f.Name, f => f.Member!, StringComparer.Ordinal);

    public static Dictionary<string, JsonElement> Capture(AdjustmentState state)
    {
        var defaults = new AdjustmentState();
        var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var spec in AdjustmentFields.All)
        {
            if (!spec.Copyable || spec.Kind == "Curve" || !Members.TryGetValue(spec.Name, out var member)) continue;
            var value = member.GetValue(state);
            var baseline = spec.Kind == "Number" ? spec.DefaultNumber : member.GetValue(defaults);
            if (Equals(value, baseline)) continue;
            var json = JsonSerializer.SerializeToElement(value is Enum ? value.ToString() : value);
            if (TryValue(spec, member.FieldType, json, out _)) result.Add(spec.Name, json);
        }
        return result;
    }

    public static SparseAdjustmentResult Apply(AdjustmentState original, IReadOnlyDictionary<string, JsonElement> fields)
    {
        var state = original.Clone();
        var applied = new List<string>();
        var skipped = new List<string>();
        foreach (var (name, value) in fields)
        {
            if (!Specs.TryGetValue(name, out var spec) || !spec.Copyable || !Members.TryGetValue(name, out var member)
                || !TryValue(spec, member.FieldType, value, out var converted))
            {
                skipped.Add(name);
                continue;
            }
            member.SetValue(state, converted);
            applied.Add(name);
        }
        return new(state, applied.ToArray(), skipped.ToArray());
    }

    public static void CommitTo(AdjustmentState target, SparseAdjustmentResult result)
    {
        foreach (var name in result.Applied) Members[name].SetValue(target, Members[name].GetValue(result.State));
    }

    public static Dictionary<string, JsonElement> DefaultsFor(IEnumerable<string> names)
    {
        var baseline = new AdjustmentState();
        var fields = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var name in names)
        {
            if (!Specs.TryGetValue(name, out var spec) || !spec.Copyable || spec.Kind == "Curve" || !Members.TryGetValue(name, out var member)) continue;
            var value = spec.Kind == "Number" ? spec.DefaultNumber : member.GetValue(baseline);
            fields[name] = JsonSerializer.SerializeToElement(value is Enum ? value.ToString() : value);
        }
        return fields;
    }

    private static bool TryValue(AdjustmentFieldSpec spec, Type type, JsonElement value, out object? converted)
    {
        converted = null;
        if (spec.Kind == "Number" && type == typeof(double) && value.ValueKind == JsonValueKind.Number
            && value.TryGetDouble(out var number) && double.IsFinite(number))
        {
            converted = Math.Clamp(number, spec.Minimum, spec.Maximum);
            return true;
        }
        if (value.ValueKind != JsonValueKind.String) return false;
        var text = value.GetString()!;
        if (spec.Kind == "String" && type == typeof(string)) { converted = text; return true; }
        if (spec.Kind != "Enum") return false;
        if (type.IsEnum && Enum.GetNames(type).Contains(text, StringComparer.Ordinal))
        {
            converted = Enum.Parse(type, text);
            return true;
        }
        // The host retains unknown demosaic strings in XMP, but a preset must
        // disclose an unsupported kernel instead of claiming it was applied.
        if (spec.Name == "demosaic" && type == typeof(string) && Enum.GetNames<DemosaicChoice>().Contains(text, StringComparer.Ordinal))
        {
            converted = text;
            return true;
        }
        return false;
    }
}
