using System;
using System.Text.Json.Serialization;

namespace Maple.WinUI.Services.Cloud
{
    public sealed class CloudTimelinePage
    {
        [JsonPropertyName("results")] public CloudTimelinePhoto[] Results { get; set; } = Array.Empty<CloudTimelinePhoto>();
        [JsonPropertyName("nextCursor")] public string? NextCursor { get; set; }
    }

    public sealed class CloudTimelinePhoto
    {
        [JsonPropertyName("address")] public string? Address { get; set; }
        [JsonPropertyName("abs_path")] public string Path { get; set; } = string.Empty;
        [JsonPropertyName("filename")] public string Filename { get; set; } = string.Empty;
        [JsonPropertyName("size")] public long Size { get; set; }
        [JsonPropertyName("mtime")] public double Mtime { get; set; }
        [JsonPropertyName("captured_at")] public string? CapturedAt { get; set; }
        [JsonPropertyName("camera")] public CloudTimelineCamera? Camera { get; set; }
        [JsonPropertyName("lens")] public string? Lens { get; set; }
        [JsonPropertyName("iso")] public int? Iso { get; set; }
        [JsonPropertyName("aperture")] public double? Aperture { get; set; }
        [JsonPropertyName("shutter")] public string? Shutter { get; set; }
        [JsonPropertyName("rating")] public int Rating { get; set; }
        [JsonPropertyName("flag")] public int Flag { get; set; }
        [JsonPropertyName("color_label")] public string? ColorLabel { get; set; }
    }

    public sealed class CloudTimelineCamera
    {
        [JsonPropertyName("make")] public string? Make { get; set; }
        [JsonPropertyName("model")] public string? Model { get; set; }
    }
}
