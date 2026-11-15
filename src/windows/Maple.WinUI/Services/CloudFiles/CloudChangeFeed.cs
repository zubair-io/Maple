using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Maple.WinUI.Services.CloudFiles;

internal sealed class CloudChangePage
{
    [JsonPropertyName("changes")] public List<CloudAssetChange> Changes { get; set; } = new();
    [JsonPropertyName("next_cursor")] public long? NextCursor { get; set; }
}

internal sealed class CloudAssetChange
{
    [JsonPropertyName("cursor")] public long Cursor { get; set; }
    [JsonPropertyName("asset_id")] public string? AssetId { get; set; }
    [JsonPropertyName("folder_id")] public string? FolderId { get; set; }
    [JsonPropertyName("kind")] public string Kind { get; set; } = string.Empty;
    [JsonPropertyName("abs_path")] public string? AbsolutePath { get; set; }
    [JsonPropertyName("relative_path")] public string? RelativePath { get; set; }
    [JsonPropertyName("at")] public DateTime At { get; set; }
}

/// <summary>Durable, server-scoped cursor store. Writes use replace-on-rename so
/// interruption cannot leave a partially serialized cursor.</summary>
internal sealed class CloudChangeCursorStore
{
    private readonly string _path;
    private readonly object _gate = new();

    internal CloudChangeCursorStore(string serverUrl, string? userId = null, string? directory = null)
    {
        directory ??= Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maple", "cloud", "changes");
        Directory.CreateDirectory(directory);
        var key = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(serverUrl.TrimEnd('/') + "\n" + (userId ?? string.Empty))));
        _path = Path.Combine(directory, key + ".json");
    }

    internal long Read()
    {
        lock (_gate)
        {
            if (!File.Exists(_path)) return 0;
            try { return Math.Max(0, JsonSerializer.Deserialize<Cursor>(File.ReadAllText(_path))?.Value ?? 0); }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                DiagLog.Write($"[cloudfiles] change cursor read failed: {ex.Message}");
                return 0;
            }
        }
    }

    internal void Write(long value)
    {
        if (value < 0) throw new ArgumentOutOfRangeException(nameof(value));
        lock (_gate)
        {
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(new Cursor(value)));
            File.Move(temp, _path, overwrite: true);
        }
    }

    private sealed record Cursor(long Value);
}

internal enum CloudChangeActionKind { RefreshDirectory, DeleteIfInSync }

internal sealed record CloudChangeAction(CloudChangeActionKind Kind, string FolderId, string RelativePath);

/// <summary>Converts feed rows into safe filesystem work. Unknown or
/// unresolvable rows are omitted and force a caller full re-list.</summary>
internal static class CloudChangePlanner
{
    internal static IReadOnlyList<CloudChangeAction> Plan(IEnumerable<CloudAssetChange> changes)
    {
        var result = new List<CloudChangeAction>();
        foreach (var change in changes.OrderBy(c => c.Cursor))
        {
            if (string.IsNullOrWhiteSpace(change.FolderId) || string.IsNullOrWhiteSpace(change.RelativePath))
                continue;
            var path = change.RelativePath.Replace('\\', '/').Trim('/');
            if (path.Length == 0 || path.Split('/').Any(part => part is "" or "." or ".."))
                continue;
            CloudChangeActionKind kind;
            if (string.Equals(change.Kind, "delete", StringComparison.OrdinalIgnoreCase))
                kind = CloudChangeActionKind.DeleteIfInSync;
            else if (change.Kind.Equals("create", StringComparison.OrdinalIgnoreCase) ||
                     change.Kind.Equals("update", StringComparison.OrdinalIgnoreCase) ||
                     change.Kind.Equals("restore", StringComparison.OrdinalIgnoreCase))
                kind = CloudChangeActionKind.RefreshDirectory;
            else
                continue;
            result.Add(new CloudChangeAction(kind, change.FolderId!, path));
        }
        return result;
    }
}
