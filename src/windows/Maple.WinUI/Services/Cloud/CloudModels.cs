using System;
using System.Text.Json.Serialization;

namespace Maple.WinUI.Services.Cloud
{
    /// <summary>Why a token refresh did not produce a session. The two failure
    /// modes are not interchangeable: only <see cref="Rejected"/> is the server
    /// saying the stored credential is no good, and only that justifies
    /// discarding it. Collapsing them would sign the user out for good over a
    /// deploy-time 503 or a rate-limited retry.</summary>
    public enum RefreshOutcome
    {
        Ok,
        /// <summary>The server refused the credential itself (400/401/403 —
        /// expired, revoked, or a reuse-detected family).</summary>
        Rejected,
        /// <summary>Unreachable, rate-limited, or a server-side fault. The
        /// credential is untested; keep it and try again later.</summary>
        Transient,
    }

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

    /// <summary>One directory level from GET /api/fs/dir — the endpoint the
    /// Apple cloud source and the File Provider browse with, and the web's
    /// /api/fs/dir-fast sibling. Immediate children only: subdirectories and
    /// this level's images are separate lists, so the client renders a tree
    /// plus a grid rather than a flattened feed.</summary>
    public sealed class CloudDirListing
    {
        [JsonPropertyName("path")] public string Path { get; set; } = string.Empty;
        [JsonPropertyName("parent")] public string? Parent { get; set; }
        [JsonPropertyName("dirs")] public CloudDirChild[] Dirs { get; set; } = Array.Empty<CloudDirChild>();
        [JsonPropertyName("images")] public CloudDirImage[] Images { get; set; } = Array.Empty<CloudDirImage>();
        /// <summary>Opaque continuation token — present only while more of
        /// this directory remains. Round-trip it verbatim.</summary>
        [JsonPropertyName("next_cursor")] public string? NextCursor { get; set; }
    }

    public class CloudDirChild
    {
        [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
        /// <summary>Absolute, symlink-resolved path on the server.</summary>
        [JsonPropertyName("path")] public string Path { get; set; } = string.Empty;
        [JsonPropertyName("mtime")] public string? Mtime { get; set; }
    }

    public sealed class CloudDirImage : CloudDirChild
    {
        [JsonPropertyName("size")] public long Size { get; set; }
        /// <summary>Lowercase extension, no dot.</summary>
        [JsonPropertyName("ext")] public string Ext { get; set; } = string.Empty;
        /// <summary>Mongo asset id — absent until the indexer has seen the
        /// file. Nothing in the browse path requires it.</summary>
        [JsonPropertyName("id")] public string? Id { get; set; }
        /// <summary>Indexed EXIF. null when indexed but unusable, absent when
        /// the indexer hasn't reached this file.</summary>
        [JsonPropertyName("exif")] public CloudDirExif? Exif { get; set; }
        // The listing's isVideo/isAudio/isStub flags are deliberately not
        // modelled: the grid shows every file the directory holds, so nothing
        // reads them. The format badge comes from the extension.
    }

    /// <summary>The `exif` subdocument on a /api/fs/dir image row. Field names
    /// are the indexer's snake_case asset schema, not the /api/search wire
    /// shape — the two differ (`camera_make` here vs a nested `camera` there).</summary>
    public sealed class CloudDirExif
    {
        [JsonPropertyName("camera_make")] public string? CameraMake { get; set; }
        [JsonPropertyName("camera_model")] public string? CameraModel { get; set; }
        [JsonPropertyName("lens")] public string? Lens { get; set; }
        [JsonPropertyName("iso")] public int? Iso { get; set; }
        [JsonPropertyName("aperture")] public double? Aperture { get; set; }
        [JsonPropertyName("shutter")] public string? Shutter { get; set; }
        [JsonPropertyName("captured_at")] public string? CapturedAt { get; set; }

        public DateTime? CapturedAtLocal =>
            DateTime.TryParse(CapturedAt, null,
                System.Globalization.DateTimeStyles.RoundtripKind, out var dt)
                ? dt.ToLocalTime()
                : null;
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

    public sealed class CloudRedeemResponse
    {
        [JsonPropertyName("access_token")] public string AccessToken { get; set; } = string.Empty;
        [JsonPropertyName("refresh_token")] public string? RefreshToken { get; set; }
        [JsonPropertyName("user")] public CloudUser? User { get; set; }
    }

    public sealed class CloudUser
    {
        [JsonPropertyName("id")] public string Id { get; set; } = string.Empty;
        [JsonPropertyName("email")] public string Email { get; set; } = string.Empty;
        [JsonPropertyName("role")] public string Role { get; set; } = string.Empty;
    }
}
