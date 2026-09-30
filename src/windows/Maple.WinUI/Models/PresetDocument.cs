using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Maple.WinUI.Models;

/// <summary>Portable scalar-only sparse preset, shared with Apple and Web (#3879).</summary>
public sealed class PresetDocument
{
    public const int MaximumBytes = 4 * 1024 * 1024;
    [JsonPropertyName("id")] public string Id { get; set; } = Guid.NewGuid().ToString();
    [JsonPropertyName("schemaVersion")] public int SchemaVersion { get; set; } = 1;
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("fields")] public Dictionary<string, JsonElement> Fields { get; set; } = new(StringComparer.Ordinal);
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; } = new(StringComparer.Ordinal);
    [JsonIgnore] public bool BuiltIn { get; set; }

    public static PresetDocument Parse(string json)
    {
        if (Encoding.UTF8.GetByteCount(json) > MaximumBytes) throw new InvalidDataException("Preset exceeds the 4 MiB limit.");
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Preset must be a JSON object.");
        RejectDuplicates(root);
        if (!root.TryGetProperty("schemaVersion", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var number) || number < 1)
            throw new InvalidDataException("Preset requires a positive schemaVersion.");
        if (!root.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Preset requires a name.");
        if (!root.TryGetProperty("fields", out var fields) || fields.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Preset requires a sparse fields object.");
        RejectDuplicates(fields);
        var preset = JsonSerializer.Deserialize<PresetDocument>(json) ?? throw new InvalidDataException("Invalid preset.");
        preset.Validate();
        return preset;
    }

    public string Serialize()
    {
        Validate();
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        if (Encoding.UTF8.GetByteCount(json) > MaximumBytes) throw new InvalidDataException("Preset exceeds the 4 MiB limit.");
        return json;
    }

    public void Validate()
    {
        if (SchemaVersion < 1) throw new InvalidDataException("Preset requires a positive schemaVersion.");
        if (string.IsNullOrWhiteSpace(Name) || Name.Trim().Length > 120 || Name.Any(char.IsControl))
            throw new InvalidDataException("Preset name must contain 1–120 characters.");
        if (string.IsNullOrWhiteSpace(Id) || Id.Length > 160) throw new InvalidDataException("Preset identity is invalid.");
        if (Fields == null || Fields.Count > 512) throw new InvalidDataException("Preset has too many fields.");
        foreach (var (key, value) in Fields)
        {
            if (string.IsNullOrWhiteSpace(key) || key.Length > 160) throw new InvalidDataException("Preset field name is invalid.");
            if (value.ValueKind == JsonValueKind.Number && (!value.TryGetDouble(out var scalar) || !double.IsFinite(scalar)))
                throw new InvalidDataException($"Preset field '{key}' must be finite.");
            if (value.ValueKind is not (JsonValueKind.Number or JsonValueKind.String or JsonValueKind.True or JsonValueKind.False))
                throw new InvalidDataException($"Preset field '{key}' must be a number, string or boolean.");
        }
    }

    private static void RejectDuplicates(JsonElement value)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
            if (!names.Add(property.Name)) throw new InvalidDataException($"Duplicate preset key '{property.Name}'.");
    }
}
