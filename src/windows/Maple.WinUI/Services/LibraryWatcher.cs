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

            // Probe runs outside any lock — blocking I/O there would stall
            // the FileSystemWatcher threads calling QueueAdded/QueueRemoved/
            // QueueRenamed. Resolve is pure (LibraryChangeQueue.cs): it just
            // combines the drained batch with what Probe found, including
            // reporting a pending rename's OLD path removed when the
            // renamed-to file has gone missing by probe time rather than
            // silently dropping it (which would leave a permanent ghost).
            var resolved = LibraryChangeQueue.Resolve(drained, Probe);

            if (resolved.Added.Count > 0 || resolved.Removed.Count > 0)
                ChangesReady?.Invoke(resolved.Added, resolved.Removed);
            if (resolved.Renamed.Count > 0)
                RenamesReady?.Invoke(resolved.Renamed);

            if (resolved.UnstableAdded.Count == 0 && resolved.UnstableRenamed.Count == 0)
                return;
            _queue.Requeue(resolved.UnstableAdded, resolved.UnstableRenamed);
            RearmDebounce();
        }

        private static LibraryChangeQueue.FileStability Probe(string path)
        {
            try
            {
                // FileShare.None: only stable once NO other handle is open — a
                // writer that allows read-sharing must not count as finished.
                using var _ = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.None);
                return LibraryChangeQueue.FileStability.Stable;
            }
            catch (FileNotFoundException)
            {
                return LibraryChangeQueue.FileStability.Missing;
            }
            catch (DirectoryNotFoundException)
            {
                return LibraryChangeQueue.FileStability.Missing;
            }
            catch (IOException)
            {
                return LibraryChangeQueue.FileStability.Locked;    // writer still holds it
            }
            catch (UnauthorizedAccessException)
            {
                return LibraryChangeQueue.FileStability.Locked;
            }
        }

        public void Dispose()
        {
            Stop();
            _debounce?.Dispose();
        }
    }
}
