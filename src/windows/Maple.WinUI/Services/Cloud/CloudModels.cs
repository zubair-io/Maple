using System;
using System.Text.Json.Serialization;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>A registered library on the Self-Hosted server
    /// (GET /api/folders).</summary>
    public sealed class CloudFolder
    {
        [JsonPropertyName("id")] public string Id { get; set; } = string.Empty;
        [JsonPropertyName("slug")] public string Slug { get; set; } = string.Empty;
        [JsonPropertyName("path")] public string Path { get; set; } = string.Empty;
        [JsonPropertyName("label")] public string? Label { get; set; }
        [JsonPropertyName("file_count")] public int FileCount { get; set; }

        public string DisplayName => string.IsNullOrEmpty(Label) ? Slug : Label!;
    }

    /// <summary>One result row from GET /api/search (the grid feed).</summary>
    public sealed class CloudSearchResult
    {
        [JsonPropertyName("_id")] public string? MongoId { get; set; }
        [JsonPropertyName("address")] public string? Address { get; set; }
        [JsonPropertyName("abs_path")] public string AbsPath { get; set; } = string.Empty;
        [JsonPropertyName("filename")] public string Filename { get; set; } = string.Empty;
        [JsonPropertyName("size")] public long Size { get; set; }
        [JsonPropertyName("captured_at")] public string? CapturedAt { get; set; }
        [JsonPropertyName("camera")] public CloudCamera? Camera { get; set; }
        [JsonPropertyName("lens")] public string? Lens { get; set; }
        [JsonPropertyName("iso")] public int? Iso { get; set; }
        [JsonPropertyName("aperture")] public double? Aperture { get; set; }
        [JsonPropertyName("shutter")] public string? Shutter { get; set; }
        [JsonPropertyName("rating")] public int Rating { get; set; }
        /// <summary>-1 reject, 0 unflagged, 1 pick.</summary>
        [JsonPropertyName("flag")] public int Flag { get; set; }
        [JsonPropertyName("color_label")] public string? ColorLabel { get; set; }
        [JsonPropertyName("has_xmp")] public bool? HasXmp { get; set; }

        public DateTime? CapturedAtLocal =>
            DateTime.TryParse(CapturedAt, null,
                System.Globalization.DateTimeStyles.RoundtripKind, out var dt)
                ? dt.ToLocalTime()
                : null;
    }

    public sealed class CloudCamera
    {
        [JsonPropertyName("make")] public string? Make { get; set; }
        [JsonPropertyName("model")] public string? Model { get; set; }
    }

    public sealed class CloudSearchPage
    {
        [JsonPropertyName("total")] public int Total { get; set; }
        [JsonPropertyName("results")] public CloudSearchResult[] Results { get; set; } = Array.Empty<CloudSearchResult>();
        [JsonPropertyName("cursorPaging")] public bool CursorPaging { get; set; }
        [JsonPropertyName("nextCursor")] public string? NextCursor { get; set; }
    }

    public sealed class CloudHealth
    {
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("product")] public string? Product { get; set; }
        [JsonPropertyName("version")] public string? Version { get; set; }
        [JsonPropertyName("db_connected")] public bool DbConnected { get; set; }
    }

    public sealed class CloudAuthBootstrap
    {
        [JsonPropertyName("claimed")] public bool Claimed { get; set; }
        [JsonPropertyName("dev_login_enabled")] public bool DevLoginEnabled { get; set; }
    }

    public sealed class CloudTokenResponse
    {
        [JsonPropertyName("access_token")] public string AccessToken { get; set; } = string.Empty;
    }
}
