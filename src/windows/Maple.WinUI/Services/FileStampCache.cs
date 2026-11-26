using System;
using System.IO;

namespace Maple.WinUI.Services
{
    internal sealed class FileStampCache<T> where T : class
    {
        private sealed record Entry(string Path, DateTime WriteTimeUtc, long Length, T Value);

        private readonly Func<T, T> _copy;
        private readonly object _gate = new();
        private Entry? _entry;
        private long _generation;

        public FileStampCache(Func<T, T> copy) => _copy = copy;

        public T? Get(string path, Func<string, T?> read)
        {
            long generation;
            lock (_gate)
                generation = _generation;
            // Stamped before the read: a write landing during the read leaves a stale stamp, so the next Get re-reads.
            var info = new FileInfo(path);
            if (!info.Exists)
                return null;
            var writeTimeUtc = info.LastWriteTimeUtc;
            var length = info.Length;
            lock (_gate)
            {
                if (_entry is { } hit && hit.Path == path && hit.WriteTimeUtc == writeTimeUtc && hit.Length == length)
                    return _copy(hit.Value);
            }
            var parsed = read(path);
            if (parsed == null)
                return null;
            lock (_gate)
            {
                // An Invalidate during the read means the content may be older than the file: do not keep it.
                if (_generation == generation)
                    _entry = new Entry(path, writeTimeUtc, length, _copy(parsed));
            }
            return parsed;
        }

        public void Invalidate()
        {
            lock (_gate)
            {
                _generation++;
                _entry = null;
            }
        }
    }
}
