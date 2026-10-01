using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Cloud;

public sealed class CloudInspectorMetadata
{
    [JsonPropertyName("xmp_mtime")] public long? XmpModifiedSeconds { get; set; }
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("ocr_text")] public string? OcrText { get; set; }
    [JsonPropertyName("faces")] public JsonElement Faces { get; set; }
    [JsonPropertyName("place")] public JsonElement Place { get; set; }
    [JsonPropertyName("vision")] public JsonElement Vision { get; set; }

    public IReadOnlyList<(string Label, string Value)> Rows()
    {
        var rows = new List<(string, string)>();
        void Add(string label, string? value) { if (!string.IsNullOrWhiteSpace(value)) rows.Add((label, value)); }
        Add("Caption", Description ?? String(Vision, "caption"));
        Add("OCR", OcrText);
        if (Faces.ValueKind == JsonValueKind.Array)
            Add("People", string.Join(", ", Faces.EnumerateArray().Select(face => String(face, "name")).Where(s => s != null).Distinct()));
        Add("Location", String(Place, "display_name") ?? String(Place, "name"));
        if (Place.ValueKind == JsonValueKind.Object && Place.TryGetProperty("lat", out var lat) &&
            Place.TryGetProperty("lon", out var lon) && lat.ValueKind == JsonValueKind.Number && lon.ValueKind == JsonValueKind.Number)
            Add("GPS", lat.GetRawText() + ", " + lon.GetRawText());
        if (Vision.ValueKind == JsonValueKind.Object && Vision.TryGetProperty("tags", out var tags) && tags.ValueKind == JsonValueKind.Array)
            Add("Tags", string.Join(", ", tags.EnumerateArray().Where(t => t.ValueKind == JsonValueKind.String).Select(t => t.GetString())));
        return rows;
    }

    private static string? String(JsonElement element, string property) => element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}

public sealed partial class CloudClient
{
    public Task<CloudInspectorMetadata?> GetInspectorMetadataAsync(string serverPath, CancellationToken cancellation) =>
        GetJsonAsync<CloudInspectorMetadata>($"api/assets/by-fspath?path={Uri.EscapeDataString(serverPath)}", cancellation);
}
