using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.Transfer;

public sealed record TransferPreviewTarget(string Id, string Name, XmpSidecarDocument Document, WhiteBalanceBaseline? Baseline);
public sealed record TransferPreviewField(string Name, string Current, string Incoming, int ChangedPhotos, int TotalPhotos);
public sealed record TransferPreviewGroup(string Id, string Label, IReadOnlyList<TransferPreviewField> Fields);
public sealed record TransferPreviewResult(IReadOnlyList<TransferPreviewGroup> Groups,
    IReadOnlyDictionary<string, AdjustmentTransferPatch> Patches, IReadOnlyList<string> Excluded);

/// <summary>Actual current/incoming values for a frozen selection (#3880). UI
/// groups, patch construction and mixed-target counts all use generated fields.</summary>
public static class TransferPreview
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static TransferPreviewResult Build(AdjustmentTransferSource source, IReadOnlyList<string> groups,
        IReadOnlyList<TransferPreviewTarget> targets, bool relativeWhiteBalance)
    {
        var patches = new Dictionary<string, AdjustmentTransferPatch>(StringComparer.Ordinal);
        foreach (var target in targets)
        {
            patches.Add(target.Id, AdjustmentTransfer.Build(source, groups, relativeWhiteBalance, target.Baseline));
        }
        var output = new List<TransferPreviewGroup>();
        foreach (var group in AdjustmentFields.Groups.Where(g => groups.Contains(g.Id)))
        {
            var fields = new List<TransferPreviewField>();
            foreach (var name in group.Fields)
            {
                if (name == "wb_scale_version")
                {
                    var current = targets.Select(t => t.Document.WbScaleVersion.ToString(CultureInfo.InvariantCulture)).ToArray();
                    var incoming = targets.Select(t => patches[t.Id].WhiteBalanceScaleVersion?.ToString(CultureInfo.InvariantCulture) ?? "unchanged").ToArray();
                    fields.Add(Row(name, current, incoming));
                    continue;
                }
                if (!targets.Any(t => patches[t.Id].Fields.ContainsKey(name))) continue;
                var oldValues = targets.Select(t => Current(t.Document, name)).ToArray();
                var newValues = targets.Select(t => Value(patches[t.Id], name)).ToArray();
                fields.Add(Row(name, oldValues, newValues));
            }
            if (group.Id == "white_balance")
                fields.Add(Row("white_balance_preset", targets.Select(t => t.Document.Adjustments.WhiteBalancePreset).ToArray(),
                    targets.Select(t => Value(patches[t.Id], "white_balance_preset")).ToArray()));
            output.Add(new(group.Id, group.Label, fields));
        }
        return new(output, patches, patches.Values.SelectMany(p => p.Excluded).Distinct().ToArray());
    }

    private static TransferPreviewField Row(string name, string[] current, string[] incoming) =>
        new(name, Describe(current), Describe(incoming), current.Zip(incoming).Count(pair => pair.First != pair.Second), current.Length);

    private static string Describe(string[] values)
    {
        var unique = values.Distinct(StringComparer.Ordinal).ToArray();
        return unique.Length switch
        {
            0 => "No targets",
            1 => unique[0],
            _ => "Mixed: " + string.Join("; ", unique.Take(4)) + (unique.Length > 4 ? $"; and {unique.Length - 4} more values" : "")
        };
    }

    private static string Value(AdjustmentTransferPatch patch, string name)
    {
        if (!patch.Fields.TryGetValue(name, out var value)) return "unchanged";
        return value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText();
    }

    private static string Current(XmpSidecarDocument document, string name)
    {
        if (name == "crop") return JsonSerializer.Serialize(document.Adjustments.Crop, Json);
        var field = AdjustmentFields.All.First(f => f.Name == name);
        var value = typeof(AdjustmentState).GetField(field.Member)!.GetValue(document.Adjustments);
        return value is string or Enum ? value.ToString()! : JsonSerializer.Serialize(value, Json);
    }
}
