using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using Maple.WinUI.Services.FileOperations;

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
    ///
    /// The actual add/remove/rename bookkeeping lives in
    /// LibraryChangeQueue (Services/FileOperations/LibraryChangeQueue.cs) —
    /// this class owns only the FileSystemWatcher wiring, the debounce
    /// timer, and the file-stability probe, none of which that WinUI-free,
    /// xUnit-tested class can or should own.
    /// </summary>
    public sealed class LibraryWatcher : IDisposable
    {
        private const int DebounceMs = 900;

        private readonly Func<string, bool> _isImageFile;
        private readonly LibraryChangeQueue _queue = new();
        private readonly object _timerGate = new();
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
                watcher.Created += (_, e) => QueueAdded(e.FullPath);
                watcher.Deleted += (_, e) => QueueRemoved(e.FullPath);
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
            lock (_timerGate)
            {
                // Kill the debounce too — a timer surviving Stop() would fire
                // Flush() for a folder the user already navigated away from.
                _debounce?.Dispose();
                _debounce = null;
            }
            _queue.Clear();
        }

        private void QueueAdded(string path)
        {
            if (!_isImageFile(path))
                return;
            _queue.QueueAdded(path);
            RearmDebounce();
        }

        private void QueueRemoved(string path)
        {
            if (!_isImageFile(path))
                return;
            _queue.QueueRemoved(path);
            RearmDebounce();
        }

        /// <summary>Only one side an image file: the grid only ever saw (or
        /// will ever see) one of the two names, so the net effect collapses
        /// to a plain arrival or departure rather than a rename to
        /// reconcile.</summary>
        private void QueueRenamed(string oldPath, string newPath)
        {
            var oldIsImage = _isImageFile(oldPath);
            var newIsImage = _isImageFile(newPath);
            if (!oldIsImage && !newIsImage)
                return;
            if (!oldIsImage)
            {
                _queue.QueueAdded(newPath);
                RearmDebounce();
                return;
            }
            if (!newIsImage)
            {
                _queue.QueueRemoved(oldPath);
                RearmDebounce();
                return;
            }
            _queue.QueueRenamed(oldPath, newPath);
            RearmDebounce();
        }

        /// <summary>One reusable timer, reset via Change — no allocation per
        /// filesystem event. No-op once the watcher is stopped.</summary>
        private void RearmDebounce()
        {
            lock (_timerGate)
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
            var drained = _queue.Drain();

            // File probes run outside any lock — blocking I/O there would
            // stall the FileSystemWatcher threads calling QueueAdded/
            // QueueRemoved/QueueRenamed. A file still mid-copy stays
            // pending; a file that vanished is dropped so a create+delete
            // flurry can never pin the debounce forever.
            var added = new List<string>();
            var unstable = new List<string>();
            foreach (var path in drained.Added)
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
            foreach (var pair in drained.Renamed)
            {
                switch (Probe(pair.Value))
                {
                    case FileProbe.Stable: renamed.Add((pair.Key, pair.Value)); break;
                    case FileProbe.Locked: unstableRenames.Add(pair); break;
                    case FileProbe.Missing: break;    // renamed again, or vanished, before we probed it
                }
            }

            if (added.Count > 0 || drained.Removed.Count > 0)
                ChangesReady?.Invoke(added, drained.Removed);
            if (renamed.Count > 0)
                RenamesReady?.Invoke(renamed);

            if (unstable.Count == 0 && unstableRenames.Count == 0)
                return;
            _queue.Requeue(unstable, unstableRenames);
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
