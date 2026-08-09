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
        private readonly Dictionary<string, string> _renamed = new(StringComparer.OrdinalIgnoreCase);
        private FileSystemWatcher? _watcher;
        private Timer? _debounce;

        /// <summary>One debounced batch of stable changes: files that appeared
        /// and files that disappeared, both already extension-filtered.</summary>
        public event Action<IReadOnlyList<string>, IReadOnlyList<string>>? ChangesReady;

        /// <summary>One debounced batch of image-to-image renames observed
        /// live (#2657) — both old and new paths, extension-filtered on both
        /// sides. Fired separately from <see cref="ChangesReady"/> so a
        /// consumer can follow the OS-reported identity directly (move the
        /// sidecar, keep the in-memory item) instead of the generic
        /// remove-then-add path, which would orphan the sidecar and lose the
        /// item's rating/flag/color-label state.</summary>
        public event Action<IReadOnlyList<(string OldPath, string NewPath)>>? RenamesReady;

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
                watcher.Renamed += (_, e) => QueueRenamed(e.OldFullPath, e.FullPath);
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
                // Kill the debounce too — a timer surviving Stop() would fire
                // Flush() for a folder the user already navigated away from.
                _debounce?.Dispose();
                _debounce = null;
                _added.Clear();
                _removed.Clear();
                _renamed.Clear();
            }
        }

        /// <summary>Handles a raw FileSystemWatcher Renamed event. Both sides
        /// image files: recorded as a pending rename pair. Only one side an
        /// image file: the grid only ever saw (or will ever see) one of the
        /// two names, so the net effect collapses to a plain arrival or
        /// departure — reuses <see cref="Queue"/> rather than duplicating its
        /// stability-probe/coalescing logic.</summary>
        private void QueueRenamed(string oldPath, string newPath)
        {
            var oldIsImage = _isImageFile(oldPath);
            var newIsImage = _isImageFile(newPath);
            if (!oldIsImage && !newIsImage)
                return;
            if (!oldIsImage)
            {
                Queue(add: newPath, remove: null);
                return;
            }
            if (!newIsImage)
            {
                Queue(add: null, remove: oldPath);
                return;
            }

            lock (_gate)
            {
                // Chain resolution: A->B is already pending and this event is
                // B->C — collapse to A->C. Without this, the second rename in
                // a rapid double-rename within one debounce window would try
                // to move a sidecar that the first rename already moved.
                var chainedFrom = _renamed.FirstOrDefault(
                    kv => string.Equals(kv.Value, oldPath, StringComparison.OrdinalIgnoreCase)).Key;
                if (chainedFrom != null)
                {
                    _renamed.Remove(chainedFrom);
                    _renamed[chainedFrom] = newPath;
                }
                else if (_added.Contains(oldPath))
                {
                    // The file arrived AND got renamed before this debounce
                    // window flushed — the app never saw the old name, so
                    // this is just an arrival under the final name, not a
                    // rename to reconcile.
                    _added.Remove(oldPath);
                    _added.Add(newPath);
                }
                else
                {
                    _renamed[oldPath] = newPath;
                }
                _added.Remove(newPath);
                _removed.Remove(newPath);
                _removed.Remove(oldPath);
            }
            RearmDebounce();
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
            RearmDebounce();
        }

        /// <summary>One reusable timer, reset via Change — no allocation per
        /// filesystem event. No-op once the watcher is stopped.</summary>
        private void RearmDebounce()
        {
            lock (_gate)
            {
                if (_watcher == null)
                    return;
                if (_debounce == null)
                    _debounce = new Timer(_ => Flush(), null, DebounceMs, Timeout.Infinite);
                else
                    _debounce.Change(DebounceMs, Timeout.Infinite);
            }
        }

        private void Flush()
        {
            List<string> candidates;
            List<string> removed;
            List<KeyValuePair<string, string>> renameCandidates;
            lock (_gate)
            {
                candidates = _added.ToList();
                removed = _removed.ToList();
                renameCandidates = _renamed.ToList();
                _added.Clear();
                _removed.Clear();
                _renamed.Clear();
            }

            // File probes run OUTSIDE the gate — blocking I/O under the lock
            // would stall the FileSystemWatcher threads calling Queue(). A file
            // still mid-copy stays pending; a file that vanished is dropped so
            // a create+delete flurry can never pin the debounce forever.
            var added = new List<string>();
            var unstable = new List<string>();
            foreach (var path in candidates)
            {
                switch (Probe(path))
                {
                    case FileProbe.Stable: added.Add(path); break;
                    case FileProbe.Locked: unstable.Add(path); break;
                    case FileProbe.Missing: break;
                }
            }

            var renamed = new List<(string OldPath, string NewPath)>();
            var unstableRenames = new List<KeyValuePair<string, string>>();
            foreach (var pair in renameCandidates)
            {
                switch (Probe(pair.Value))
                {
                    case FileProbe.Stable: renamed.Add((pair.Key, pair.Value)); break;
                    case FileProbe.Locked: unstableRenames.Add(pair); break;
                    case FileProbe.Missing: break;    // renamed again, or vanished, before we probed it
                }
            }

            if (added.Count > 0 || removed.Count > 0)
                ChangesReady?.Invoke(added, removed);
            if (renamed.Count > 0)
                RenamesReady?.Invoke(renamed);

            if (unstable.Count == 0 && unstableRenames.Count == 0)
                return;
            lock (_gate)
            {
                foreach (var path in unstable)
                    _added.Add(path);
                foreach (var pair in unstableRenames)
                    _renamed[pair.Key] = pair.Value;
            }
            RearmDebounce();
        }

        private enum FileProbe { Stable, Locked, Missing }

        private static FileProbe Probe(string path)
        {
            try
            {
                // FileShare.None: only stable once NO other handle is open — a
                // writer that allows read-sharing must not count as finished.
                using var _ = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.None);
                return FileProbe.Stable;
            }
            catch (FileNotFoundException)
            {
                return FileProbe.Missing;
            }
            catch (DirectoryNotFoundException)
            {
                return FileProbe.Missing;
            }
            catch (IOException)
            {
                return FileProbe.Locked;    // writer still holds it
            }
            catch (UnauthorizedAccessException)
            {
                return FileProbe.Locked;
            }
        }

        public void Dispose()
        {
            Stop();
            _debounce?.Dispose();
        }
    }
}
