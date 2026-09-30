using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services;

public sealed record PresetLibrary(IReadOnlyList<PresetDocument> Presets, IReadOnlyList<string> Errors);

/// <summary>Atomic local user-preset documents. Presets never write photo originals (#3879).</summary>
public sealed class PresetStore
{
    private readonly string _directory;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly PresetDocument[] _builtIns;

    public PresetStore(string? directory = null)
    {
        _directory = directory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maple", "Presets");
        using var stream = typeof(PresetStore).Assembly.GetManifestResourceStream("Maple.BuiltinPresets.json")
            ?? throw new InvalidDataException("Bundled presets are missing.");
        using var bundle = JsonDocument.Parse(stream);
        _builtIns = bundle.RootElement.GetProperty("presets").EnumerateArray().Select(item =>
        {
            var preset = PresetDocument.Parse(item.GetRawText());
            preset.BuiltIn = true;
            return preset;
        }).ToArray();
    }

    public async Task<PresetLibrary> LoadAsync(CancellationToken cancellation = default)
    {
        await _gate.WaitAsync(cancellation);
        try { return await LoadCoreAsync(cancellation); }
        finally { _gate.Release(); }
    }

    private async Task<PresetLibrary> LoadCoreAsync(CancellationToken cancellation)
    {
        var presets = _builtIns.Select(Clone).ToList();
        var errors = new List<string>();
        if (File.Exists(_directory)) throw new IOException("The presets folder is occupied by a file.");
        if (Directory.Exists(_directory))
            foreach (var path in Directory.EnumerateFiles(_directory, "*.json"))
            {
                cancellation.ThrowIfCancellationRequested();
                try
                {
                    var preset = await ReadAsync(path, cancellation);
                    if (!Guid.TryParse(preset.Id, out _) || Path.GetFileNameWithoutExtension(path) != preset.Id)
                        throw new InvalidDataException("Stored preset identity does not match its filename.");
                    presets.Add(preset);
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or DecoderFallbackException)
                { errors.Add($"{Path.GetFileName(path)}: {error.Message}"); }
            }
        return new(presets.OrderByDescending(p => p.BuiltIn).ThenBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToArray(), errors);
    }

    public Task<PresetDocument> CreateAsync(string name, Dictionary<string, JsonElement> fields, CancellationToken cancellation = default) =>
        SaveNewAsync(new PresetDocument { Name = name, Fields = fields }, cancellation);

    public async Task<PresetDocument> ImportAsync(string path, string? name = null, CancellationToken cancellation = default)
    {
        var preset = await ReadAsync(path, cancellation);
        preset.Id = Guid.NewGuid().ToString();
        preset.BuiltIn = false;
        if (name != null) preset.Name = name;
        return await SaveNewAsync(preset, cancellation);
    }

    private async Task<PresetDocument> SaveNewAsync(PresetDocument preset, CancellationToken cancellation)
    {
        var snapshot = Clone(preset);
        await _gate.WaitAsync(cancellation);
        try
        {
            await ValidateNameAsync(snapshot.Name, null, cancellation);
            snapshot.Name = snapshot.Name.Trim();
            if (snapshot.Fields.Count == 0) throw new InvalidDataException("No edited settings to save. Adjust something first.");
            Directory.CreateDirectory(_directory);
            await WriteAtomicAsync(UserPath(snapshot.Id), snapshot.Serialize(), false, cancellation);
            return snapshot;
        }
        finally { _gate.Release(); }
    }

    public async Task<PresetDocument> RenameAsync(string id, string name, CancellationToken cancellation = default)
    {
        await _gate.WaitAsync(cancellation);
        try
        {
            var path = UserPath(id);
            var preset = await ReadAsync(path, cancellation);
            await ValidateNameAsync(name, id, cancellation);
            preset.Name = name.Trim();
            await WriteAtomicAsync(path, preset.Serialize(), true, cancellation);
            return preset;
        }
        finally { _gate.Release(); }
    }

    public async Task DeleteAsync(string id, CancellationToken cancellation = default)
    {
        await _gate.WaitAsync(cancellation);
        try { File.Delete(UserPath(id)); }
        finally { _gate.Release(); }
    }

    public static Task ExportAsync(PresetDocument preset, string path, CancellationToken cancellation = default) =>
        WriteAtomicAsync(path, preset.Serialize(), true, cancellation);

    private async Task ValidateNameAsync(string name, string? exceptId, CancellationToken cancellation)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Trim().Length > 120 || name.Any(char.IsControl))
            throw new InvalidDataException("Preset names must contain 1–120 printable characters.");
        var library = await LoadCoreAsync(cancellation);
        if (library.Presets.Any(p => p.Id != exceptId && string.Equals(p.Name, name.Trim(), StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException($"A preset named '{name.Trim()}' already exists.");
    }

    private string UserPath(string id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new InvalidDataException("Built-in presets cannot be modified.");
        return Path.Combine(_directory, id + ".json");
    }

    private static PresetDocument Clone(PresetDocument preset)
    {
        var clone = PresetDocument.Parse(preset.Serialize());
        clone.BuiltIn = preset.BuiltIn;
        return clone;
    }

    private static async Task<PresetDocument> ReadAsync(string path, CancellationToken cancellation)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous);
        if (stream.Length > PresetDocument.MaximumBytes) throw new InvalidDataException("Preset exceeds the 4 MiB limit.");
        using var reader = new StreamReader(stream, new UTF8Encoding(false, true));
        return PresetDocument.Parse(await reader.ReadToEndAsync(cancellation));
    }

    private static async Task WriteAtomicAsync(string path, string json, bool overwrite, CancellationToken cancellation)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, json, new UTF8Encoding(false), cancellation);
            cancellation.ThrowIfCancellationRequested();
            File.Move(temporary, path, overwrite);
        }
        finally { try { File.Delete(temporary); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { } }
    }
}
