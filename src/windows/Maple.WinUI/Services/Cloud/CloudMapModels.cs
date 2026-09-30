using System;
using System.Globalization;
using System.Text.Json.Serialization;

namespace Maple.WinUI.Services.Cloud;

// Transport for #3882; the production map host and navigation remain tracked there.
public readonly record struct CloudMapViewport(double West, double South, double East, double North, int Zoom)
{
    public string ToQueryString()
    {
        if (!double.IsFinite(West) || !double.IsFinite(East) || West < -180 || West > 180 || East < -180 || East > 180
            || !double.IsFinite(South) || !double.IsFinite(North) || South < -90 || North > 90 || South > North
            || Zoom < 0 || Zoom > 20)
            throw new ArgumentOutOfRangeException(nameof(CloudMapViewport));
        return string.Create(CultureInfo.InvariantCulture, $"bbox={West:R},{South:R},{East:R},{North:R}&zoom={Zoom}");
    }
}

public sealed class CloudMapConfig
{
    [JsonPropertyName("tile_url")] public string? TileUrl { get; set; }
}

public sealed class CloudMapClusters
{
    [JsonPropertyName("cells")] public CloudMapCell[]? Cells { get; set; }
}

public sealed class CloudMapCell
{
    [JsonPropertyName("lat")] public double Latitude { get; set; } = double.NaN;
    [JsonPropertyName("lng")] public double Longitude { get; set; } = double.NaN;
    [JsonPropertyName("count")] public long Count { get; set; }
    [JsonPropertyName("representativeAssetId")] public string? RepresentativeAssetId { get; set; }
    [JsonPropertyName("placeLabel")] public string? PlaceLabel { get; set; }
    [JsonPropertyName("thumbKey")] public string? ThumbnailPath { get; set; }

    [JsonIgnore] public bool IsValid => double.IsFinite(Latitude) && double.IsFinite(Longitude)
        && Latitude >= -90 && Latitude <= 90 && Longitude >= -180 && Longitude <= 180
        && Count > 0 && !string.IsNullOrWhiteSpace(RepresentativeAssetId);
}
