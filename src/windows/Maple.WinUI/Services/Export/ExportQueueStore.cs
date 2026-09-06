using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
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
        using var lease = LockRecipes();
        return ReadRecipes();
    }

    private IReadOnlyList<ExportRecipe> ReadRecipes()
    {
        var path = Path.Combine(_root, "recipes.json");
        return File.Exists(path)
            ? JsonSerializer.Deserialize<List<ExportRecipe>>(File.ReadAllText(path), Json)
                ?? throw new InvalidDataException("Recipe collection is empty.")
            : Array.Empty<ExportRecipe>();
    }

    public void SaveRecipe(ExportRecipe recipe)
    {
        using var lease = LockRecipes();
        // Unsupported policy values remain intact for interchange; execution validates them.
        var recipes = ReadRecipes().Where(r => r.Name != recipe.Name).Append(recipe).ToArray();
        WriteAtomic(Path.Combine(_root, "recipes.json"), JsonSerializer.Serialize(recipes, Json));
    }

    private IDisposable LockRecipes()
    {
        // Read and atomic replace are one transaction across app processes. Saving
        // runs off the UI thread; a short bounded wait lets another window finish.
        var wait = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                return new FileStream(Path.Combine(_root, "recipes.lock"), FileMode.OpenOrCreate,
                    FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);
            }
            catch (IOException) when (wait.Elapsed < TimeSpan.FromSeconds(5)) { Thread.Sleep(25); }
        }
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
