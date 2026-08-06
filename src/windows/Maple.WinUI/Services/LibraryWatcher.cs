using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Watches the folder currently open in Browse for image-file arrivals,
    /// deletions and renames (#2585). Top-level only — the browse grid shows a
    /// folder's own images, so the watcher must never fan out into a huge
    /// subtree either. Events are debounced into one batch: file copies fire
    /// Created + several LastWrite changes, and a camera-card import drops
    /// hundreds of files in seconds; one coalesced (added, removed) callback
    /// keeps the grid update cheap. Sidecar (*.xmp) changes are handled by
    /// SidecarWatcher, not here.
    /// </summary>
    public sealed class LibraryWatcher : IDisposable
    {
        private const int DebounceMs = 900;

        private readonly Func<string, bool> _isImageFile;
        private readonly object _gate = new();
        private readonly HashSet<string> _added = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _removed = new(StringComparer.OrdinalIgnoreCase);
        private FileSystemWatcher? _watcher;
        private Timer? _debounce;

        /// <summary>One debounced batch of stable changes: files that appeared
        /// and files that disappeared, both already extension-filtered.</summary>
        public event Action<IReadOnlyList<string>, IReadOnlyList<string>>? ChangesReady;

        public LibraryWatcher(Func<string, bool> isImageFile)
        {
            _isImageFile = isImageFile;
        }

        public void Watch(string folderPath)
        {
            Stop();
            try
            {
                var watcher = new FileSystemWatcher(folderPath)
                {
                    IncludeSubdirectories = false,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.Size,
                };
                watcher.Created += (_, e) => Queue(add: e.FullPath, remove: null);
                watcher.Deleted += (_, e) => Queue(add: null, remove: e.FullPath);
                watcher.Renamed += (_, e) => Queue(add: e.FullPath, remove: e.OldFullPath);
                watcher.EnableRaisingEvents = true;
                _watcher = watcher;
            }
            catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
            {
                // Unwatchable folder (unplugged share, revoked ACL): browsing
                // still works, the grid just won't live-update.
                DiagLog.Write($"[library] watch failed for {folderPath}: {ex.Message}");
            }
        }

        public void Stop()
        {
            _watcher?.Dispose();
            _watcher = null;
            lock (_gate)
            {
                _added.Clear();
                _removed.Clear();
            }
        }

        private void Queue(string? add, string? remove)
        {
            var addOk = add != null && _isImageFile(add);
            var removeOk = remove != null && _isImageFile(remove);
            if (!addOk && !removeOk)
                return;
            lock (_gate)
            {
                if (addOk)
                {
                    _added.Add(add!);
                    _removed.Remove(add!);
                }
                if (removeOk)
                {
                    _removed.Add(remove!);
                    _added.Remove(remove!);
                }
            }
            _debounce?.Dispose();
            _debounce = new Timer(_ => Flush(), null, DebounceMs, Timeout.Infinite);
        }

        private void Flush()
        {
            List<string> added;
            List<string> removed;
            lock (_gate)
            {
                // A file still mid-copy stays pending: re-arm the debounce so
                // the batch lands once the writer releases it.
                var unstable = _added.Where(IsLockedOrMissing).ToList();
                added = _added.Except(unstable, StringComparer.OrdinalIgnoreCase).ToList();
                removed = _removed.ToList();
                _added.Clear();
                foreach (var path in unstable)
                    _added.Add(path);
                _removed.Clear();
            }
            if (added.Count > 0 || removed.Count > 0)
                ChangesReady?.Invoke(added, removed);
            lock (_gate)
            {
                if (_added.Count > 0)
                {
                    _debounce?.Dispose();
                    _debounce = new Timer(_ => Flush(), null, DebounceMs, Timeout.Infinite);
                }
            }
        }

        private static bool IsLockedOrMissing(string path)
        {
            try
            {
                using var _ = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                return false;
            }
            catch (FileNotFoundException)
            {
                return true;
            }
            catch (IOException)
            {
                return true;    // writer still holds it
            }
            catch (UnauthorizedAccessException)
            {
                return true;
            }
        }

        public void Dispose()
        {
            Stop();
            _debounce?.Dispose();
        }
    }
}
