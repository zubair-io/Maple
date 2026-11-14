using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.Services.CloudFiles;

internal sealed record ResolvedCloudFilesAddress(string Address, string FolderId, string RelativePath);

/// <summary>Pure Cloud Files address and unified-listing mapping logic. New
/// placeholders use stable slug:relPath identities; absolute identities from
/// older builds are translated against the registered library roots.</summary>
internal static partial class CloudFilesAddress
{
    private static readonly Regex SlugPattern = SlugRegex();

    internal static bool TryResolve(
        string identity,
        IReadOnlyList<CloudFolder> folders,
        out ResolvedCloudFilesAddress resolved)
    {
        resolved = null!;
        if (string.IsNullOrWhiteSpace(identity)) return false;

        var colon = identity.IndexOf(':');
        if (colon > 0 && SlugPattern.IsMatch(identity[..colon]))
        {
            var slug = identity[..colon];
            var relative = identity[(colon + 1)..];
            var folder = folders.FirstOrDefault(item => item.Slug == slug);
            if (folder == null || !IsSafeRelativePath(relative)) return false;
            resolved = new ResolvedCloudFilesAddress(slug + ":" + relative, folder.Id, relative);
            return true;
        }

        // Previous Cloud Files builds stored absolute server paths. Normalize
        // separators only; path case is server-owned and must remain exact.
        var candidate = NormalizeServerPath(identity);
        CloudFolder? bestFolder = null;
        string? bestRelative = null;
        var bestRootLength = -1;
        foreach (var folder in folders)
        {
            var root = NormalizeServerPath(folder.Path);
            var trimmedRoot = root.Length > 1 ? root.TrimEnd('/') : root;
            string? relative = null;
            if (string.Equals(candidate, trimmedRoot, StringComparison.Ordinal))
                relative = string.Empty;
            else if (trimmedRoot == "/" && candidate.StartsWith("/", StringComparison.Ordinal))
                relative = candidate.TrimStart('/');
            else if (candidate.StartsWith(trimmedRoot + "/", StringComparison.Ordinal))
                relative = candidate[(trimmedRoot.Length + 1)..];

            if (relative == null || trimmedRoot.Length <= bestRootLength || !IsSafeRelativePath(relative))
                continue;
            bestFolder = folder;
            bestRelative = relative;
            bestRootLength = trimmedRoot.Length;
        }

        if (bestFolder == null || bestRelative == null) return false;
        resolved = new ResolvedCloudFilesAddress(
            bestFolder.Slug + ":" + bestRelative, bestFolder.Id, bestRelative);
        return true;
    }

    internal static IReadOnlyList<PlaceholderEntry> MapListing(CloudFolderListing listing)
    {
        var entries = new List<PlaceholderEntry>();
        Add(listing.Folders, isDirectory: true);
        Add(listing.Images, isDirectory: false);
        Add(listing.Files, isDirectory: false);
        Add(listing.Sidecars, isDirectory: false);
        return entries
            .OrderBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(entry => entry.Name, StringComparer.Ordinal)
            .ToArray();

        void Add(IEnumerable<CloudFolderEntry>? source, bool isDirectory)
        {
            foreach (var entry in source ?? Array.Empty<CloudFolderEntry>())
            {
                if (string.IsNullOrWhiteSpace(entry.Name) || string.IsNullOrWhiteSpace(entry.Address))
                    continue;
                entries.Add(new PlaceholderEntry(
                    entry.Name,
                    entry.Address,
                    isDirectory,
                    isDirectory ? 0 : Math.Max(0, entry.Size),
                    DateTime.TryParse(entry.Mtime, CultureInfo.InvariantCulture,
                        DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var mtime)
                        ? DateTime.SpecifyKind(mtime, DateTimeKind.Utc)
                        : DateTime.UnixEpoch));
            }
        }
    }

    private static string NormalizeServerPath(string path) => path.Replace('\\', '/');

    private static bool IsSafeRelativePath(string relativePath) =>
        relativePath.Length == 0 ||
        (!relativePath.StartsWith("/", StringComparison.Ordinal) &&
         !relativePath.Contains('\\') &&
         !relativePath.Contains('\0') &&
         relativePath.Split('/').All(segment => segment.Length > 0 && segment is not ("." or "..")));

    [GeneratedRegex("^[a-z0-9-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex SlugRegex();
}
