// LibraryChangeQueue.cs — the pure debounce bookkeeping behind
// LibraryWatcher.cs's live grid updates (#2585) and its rename tracking
// (#2657). Split out so the state-machine decisions (what a Created,
// Deleted, or Renamed event does to the pending add/remove/rename sets)
// are exercisable without a real FileSystemWatcher, Timer, or filesystem —
// LibraryWatcher owns those; this owns only the bookkeeping. WinUI-free by
// construction, so it links into Maple.WinUI.Tests via this directory's
// existing `Services\FileOperations\*.cs` wildcard include, the same way
// RenameReconciliationLogic.cs does.
//
// Every method here is safe to call from any thread — FileSystemWatcher
// raises events on its own pool, and LibraryWatcher's debounce timer fires
// on yet another — so the three collections are gate-protected internally
// rather than trusting callers to synchronize.

using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.Services.FileOperations
{
    public sealed class LibraryChangeQueue
    {
        private readonly object _gate = new();
        private readonly HashSet<string> _added = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _removed = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> _renamed = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>One drained batch: everything pending at the moment of
        /// the call, with the queue cleared back to empty.</summary>
        public readonly record struct Drained(
            IReadOnlyList<string> Added,
            IReadOnlyList<string> Removed,
            IReadOnlyList<KeyValuePair<string, string>> Renamed);

        public void Clear()
        {
            lock (_gate)
            {
                _added.Clear();
                _removed.Clear();
                _renamed.Clear();
            }
        }

        /// <summary>A file appeared. Cancels any pending removal of the same
        /// path (a delete-then-recreate flurry nets out to "still there").</summary>
        public void QueueAdded(string path)
        {
            lock (_gate)
            {
                _added.Add(path);
                _removed.Remove(path);
            }
        }

        /// <summary>A file disappeared. If <paramref name="path"/> is
        /// actually the NEW side of a still-pending rename (rename A-&gt;B,
        /// then B is deleted, inside one debounce window), the removal is
        /// translated back to the ORIGINAL name A — the only name the grid
        /// (or a sidecar move) could ever have known the file by — and the
        /// now-moot pending rename is dropped rather than surfaced.</summary>
        public void QueueRemoved(string path)
        {
            lock (_gate)
            {
                var renamedFrom = _renamed.FirstOrDefault(
                    kv => string.Equals(kv.Value, path, StringComparison.OrdinalIgnoreCase)).Key;
                if (renamedFrom != null)
                {
                    _renamed.Remove(renamedFrom);
                    path = renamedFrom;
                }
                _removed.Add(path);
                _added.Remove(path);
            }
        }

        /// <summary>A file was renamed (both sides already confirmed to be
        /// image files by the caller — LibraryWatcher routes a rename with
        /// only one image-file side through <see cref="QueueAdded"/> or
        /// <see cref="QueueRemoved"/> instead, since the grid only ever saw,
        /// or will ever see, one of the two names).</summary>
        public void QueueRenamed(string oldPath, string newPath)
        {
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
                    _added.Remove(newPath);
                    _removed.Remove(newPath);
                    _removed.Remove(oldPath);
                    return;
                }
                if (_added.Contains(oldPath))
                {
                    // The file arrived AND got renamed before this debounce
                    // window flushed — the app never saw the old name, so
                    // this is just an arrival under the final name, not a
                    // rename to reconcile. The new name must NOT then be
                    // scrubbed by the cleanup below (that was the #2762
                    // review bug: an unconditional _added.Remove(newPath)
                    // here cancelled the Add two lines above it, so a
                    // create-then-rename inside one window never reached
                    // the UI at all) — this branch returns immediately
                    // instead of falling into that cleanup.
                    _added.Remove(oldPath);
                    _added.Add(newPath);
                    return;
                }
                _renamed[oldPath] = newPath;
                _added.Remove(newPath);
                _removed.Remove(newPath);
                _removed.Remove(oldPath);
            }
        }

        /// <summary>Snapshots everything pending and clears back to empty —
        /// the moment a debounce timer fires, before any stability probing
        /// (which needs real file I/O, so it stays in LibraryWatcher).</summary>
        public Drained Drain()
        {
            lock (_gate)
            {
                var drained = new Drained(_added.ToList(), _removed.ToList(), _renamed.ToList());
                _added.Clear();
                _removed.Clear();
                _renamed.Clear();
                return drained;
            }
        }

        /// <summary>Re-queues entries a stability probe found still locked
        /// (mid-copy) — they stay pending for the next debounce cycle
        /// instead of being reported or dropped.</summary>
        public void Requeue(IEnumerable<string> unstableAdds, IEnumerable<KeyValuePair<string, string>> unstableRenames)
        {
            lock (_gate)
            {
                foreach (var path in unstableAdds)
                    _added.Add(path);
                foreach (var pair in unstableRenames)
                    _renamed[pair.Key] = pair.Value;
            }
        }
    }
}
