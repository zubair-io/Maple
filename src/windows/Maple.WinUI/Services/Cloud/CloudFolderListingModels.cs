using System;
using System.Text.Json.Serialization;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>One page of GET /api/folder/:slug/* — the unified enriched
    /// listing (#4001) the Apple File Provider enumerates. Every entry is
    /// addressed by `slug:relPath` and carries its on-disk size and mtime;
    /// sidecars are only the ones paired to an indexed asset.</summary>
    public sealed class CloudFolderListing
    {
        [JsonPropertyName("address")] public string Address { get; set; } = string.Empty;
        [JsonPropertyName("folders")] public CloudFolderEntry[] Folders { get; set; } = Array.Empty<CloudFolderEntry>();
        [JsonPropertyName("images")] public CloudFolderEntry[] Images { get; set; } = Array.Empty<CloudFolderEntry>();
        [JsonPropertyName("files")] public CloudFolderEntry[] Files { get; set; } = Array.Empty<CloudFolderEntry>();
        [JsonPropertyName("sidecars")] public CloudFolderEntry[] Sidecars { get; set; } = Array.Empty<CloudFolderEntry>();
        /// <summary>Opaque continuation token — present only while more of
        /// this directory remains. Round-trip it verbatim.</summary>
        [JsonPropertyName("next_cursor")] public string? NextCursor { get; set; }
    }

    public sealed class CloudFolderEntry
    {
        [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
        [JsonPropertyName("address")] public string Address { get; set; } = string.Empty;
        [JsonPropertyName("size")] public long Size { get; set; }
        /// <summary>ISO-8601.</summary>
        [JsonPropertyName("mtime")] public string? Mtime { get; set; }
    }
}
