using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Maple.WinUI.Generated;

namespace Maple.WinUI.Services.Export;

/// <summary>Small durable ledgers, independent of source folders and sidecars.</summary>
public sealed class ExportQueueStore
{
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };
    private readonly string _root;

    public ExportQueueStore(string root)
    {
        _root = Path.GetFullPath(root);
        Directory.CreateDirectory(_root);
    }

    private string JobPath(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new InvalidDataException("Invalid export job id.");
        return Path.Combine(_root, $"{id}.json");
    }

    public IDisposable Lock(string id) => new FileStream(JobPath(id) + ".lock",
        FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);

    public IDisposable LockQueue() => new FileStream(Path.Combine(_root, "queue.lock"),
        FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);

    public void Save(ExportQueueJob job) => WriteAtomic(JobPath(job.Id), JsonSerializer.Serialize(job, Json));

    public ExportQueueJob Load(string id)
    {
        var job = JsonSerializer.Deserialize<ExportQueueJob>(File.ReadAllText(JobPath(id)), Json)
            ?? throw new InvalidDataException("Export queue record is empty.");
        if (job.SchemaVersion != 1 || job.Id != id)
            throw new InvalidDataException("Unsupported or mismatched export queue record.");
        return job;
    }

    public IReadOnlyList<ExportQueueListing> ListJobs() => Directory.EnumerateFiles(_root, "*.json")
        .Where(path => Guid.TryParseExact(Path.GetFileNameWithoutExtension(path), "N", out _))
        .Select(path => Load(Path.GetFileNameWithoutExtension(path)))
        .Select(job => new ExportQueueListing(job.Id, job.CreatedAt, job.Recipe.Name, job.Entries.Count))
        .OrderByDescending(job => job.CreatedAt).ToArray();

    public IReadOnlyList<ExportRecipe> Recipes()
    {
        var path = Path.Combine(_root, "recipes.json");
        return File.Exists(path)
            ? JsonSerializer.Deserialize<List<ExportRecipe>>(File.ReadAllText(path), Json)
                ?? throw new InvalidDataException("Recipe collection is empty.")
            : Array.Empty<ExportRecipe>();
    }

    public void SaveRecipe(ExportRecipe recipe)
    {
        // Unsupported policy values remain intact for interchange; execution validates them.
        var recipes = Recipes().Where(r => r.Name != recipe.Name).Append(recipe).ToArray();
        WriteAtomic(Path.Combine(_root, "recipes.json"), JsonSerializer.Serialize(recipes, Json));
    }

    private static void WriteAtomic(string path, string json)
    {
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.WriteThrough))
            {
                using var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false), leaveOpen: true);
                writer.Write(json);
                writer.Flush();
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
