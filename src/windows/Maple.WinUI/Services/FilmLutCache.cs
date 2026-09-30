using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Generated;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services;

/// <summary>Immutable decoded shared-core film lattice, prepared once per look.</summary>
public sealed class FilmLut
{
    public string Id { get; }
    public uint Size { get; }
    public uint Key { get; }
    internal float[] Data { get; }
    internal FilmLutHandle? NativeHandle { get; }
    internal FilmLut(string id, uint size, float[] data, FilmLutHandle? nativeHandle = null)
    {
        Id = id;
        Size = size;
        Data = data;
        NativeHandle = nativeHandle;
        uint hash = 2166136261;
        foreach (var value in System.Text.Encoding.UTF8.GetBytes(id)) hash = unchecked((hash ^ value) * 16777619);
        Key = hash == 0 ? 1 : hash;
    }
}

/// <summary>#3877 shared host resource integration. Load outside the render
/// loop, then retain the returned lattice through slider ticks and look switches.
/// Decoding uses raw-core's MLUT parser, not a second C# format implementation.</summary>
public sealed class FilmLutCache
{
    private readonly string _directory;
    private readonly Func<byte[], (uint Size, float[] Data)> _decode;
    private readonly bool _prepareNative;
    private readonly HashSet<string> _ids = FilmCatalog.All.Select(entry => entry.Id).ToHashSet(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Lazy<Task<FilmLut>>> _loads = new(StringComparer.Ordinal);

    public FilmLutCache(string? directory = null) : this(directory ?? Path.Combine(AppContext.BaseDirectory, "film-luts"), Decode) { _prepareNative = true; }

    internal FilmLutCache(string directory, Func<byte[], (uint Size, float[] Data)> decode) =>
        (_directory, _decode) = (directory, decode);

    public async Task<FilmLut?> LoadAsync(string id, CancellationToken cancellation = default)
    {
        if (string.IsNullOrEmpty(id)) return null;
        if (!_ids.Contains(id)) throw new InvalidDataException($"Film look '{id}' is not in the shared catalog.");
        var load = _loads.GetOrAdd(id, key => new Lazy<Task<FilmLut>>(() => Task.Run(async () =>
        {
            var path = Path.Combine(_directory, key + ".mlut");
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
                4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
            if (stream.Length > 16 * 1024 * 1024) throw new InvalidDataException("Film resource exceeds the 16 MiB limit.");
            var bytes = new byte[checked((int)stream.Length)];
            await stream.ReadExactlyAsync(bytes);
            var decoded = _decode(bytes);
            if (decoded.Size < 2 || decoded.Data.LongLength != checked((long)decoded.Size * decoded.Size * decoded.Size * 3)
                || decoded.Data.Any(value => !float.IsFinite(value)))
                throw new InvalidDataException("Film resource contains an invalid lattice.");
            var native = _prepareNative ? FilmLutHandle.Create(decoded.Size, decoded.Data) : null;
            return new FilmLut(key, decoded.Size, decoded.Data, native);
        }), LazyThreadSafetyMode.ExecutionAndPublication));
        try { return await load.Value.WaitAsync(cancellation); }
        catch
        {
            // A cancelled waiter must not cancel a shared load. A real failure
            // may be retried after a missing/corrupt installed resource is repaired.
            if (load.IsValueCreated && load.Value.IsFaulted)
                ((ICollection<KeyValuePair<string, Lazy<Task<FilmLut>>>>)_loads).Remove(new(id, load));
            throw;
        }
    }

    private static unsafe (uint Size, float[] Data) Decode(byte[] bytes)
    {
        // Shared catalog uses 33 nodes; allow larger valid resources with a
        // bounded grow-and-retry, exclusively on the loader worker.
        for (var size = 33; size <= 129; size = size * 2 - 1)
        {
            var data = new float[checked(size * size * size * 3)];
            int result;
            fixed (byte* input = bytes)
            fixed (float* output = data)
                result = RawFfi.maple_film_lut_decode(input, (nuint)bytes.Length, output, (nuint)data.Length);
            if (result == -2) continue;
            if (result < 2) throw new InvalidDataException("Cannot decode film resource: " + RawFfi.LastError());
            var length = checked(result * result * result * 3);
            if (length != data.Length) Array.Resize(ref data, length);
            return ((uint)result, data);
        }
        throw new InvalidDataException("Film lattice exceeds the supported resource limit.");
    }
}
