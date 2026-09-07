using System;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Owns one native cancel-flag handle's lifecycle: install a freshly
    /// allocated handle (<see cref="Reset"/>), signal it early
    /// (<see cref="Cancel"/>), and free it once the task that allocated it
    /// finishes (<see cref="Release"/>) — synchronized so a signal and a
    /// free of the SAME handle can never interleave, and a task's own
    /// <see cref="Release"/> can never null out a NEWER handle a later
    /// <see cref="Reset"/> already installed.
    ///
    /// #3417 Jules review: <c>EditSessionViewModel</c> used to free a
    /// decode's native cancel flag in its background task's <c>finally</c>
    /// without ever clearing the field that pointed at it, so a LATER,
    /// unrelated <c>CancelActiveDecode()</c> call could read that dangling
    /// pointer and call <c>maple_cancel_flag_set</c> on already-freed
    /// memory — a use-after-free. The plain field read-then-clear was also
    /// unsynchronized against that free running concurrently on another
    /// thread. This type centralizes both fixes behind one lock per
    /// handle's lifecycle, and takes <c>set</c>/<c>free</c> as injected
    /// delegates so the lifecycle logic is testable without the real
    /// raw-ffi P/Invoke surface.
    /// </summary>
    public sealed class CancelFlagSlot
    {
        private readonly Action<IntPtr> _set;
        private readonly Action<IntPtr> _free;
        private readonly object _gate;
        private IntPtr _current = IntPtr.Zero;

        /// <param name="set">Signals a still-live handle (e.g.
        /// <c>maple_cancel_flag_set</c>).</param>
        /// <param name="free">Releases a handle's native memory (e.g.
        /// <c>maple_cancel_flag_free</c>).</param>
        /// <param name="gate">The lock object to synchronize under.
        /// Sharing one instance across multiple slots (as
        /// <c>EditSessionViewModel</c> does for its decode and AMaZE-upgrade
        /// slots) is safe — each slot only ever touches its own
        /// <see cref="_current"/> field — and keeps every cancel-flag
        /// operation on the session serialized under a single object.
        /// Defaults to a private instance when omitted.</param>
        public CancelFlagSlot(Action<IntPtr> set, Action<IntPtr> free, object? gate = null)
        {
            _set = set;
            _free = free;
            _gate = gate ?? new object();
        }

        /// <summary>Installs <paramref name="flag"/> — a handle the caller
        /// just allocated — as the current one. Does not free whatever was
        /// current before: a caller only replaces the handle once the
        /// previous owner's task has already released (or is about to
        /// release) its own via <see cref="Release"/>.</summary>
        public void Reset(IntPtr flag)
        {
            lock (_gate)
            {
                _current = flag;
            }
        }

        /// <summary>Signals whatever handle is current, then clears it. A
        /// no-op when nothing is current (already released, or never
        /// set).</summary>
        public void Cancel()
        {
            lock (_gate)
            {
                if (_current == IntPtr.Zero)
                    return;
                _set(_current);
                _current = IntPtr.Zero;
            }
        }

        /// <summary>Frees <paramref name="flag"/> — the handle the caller
        /// itself allocated, always freed unconditionally — and clears the
        /// current handle ONLY if it still equals <paramref name="flag"/>:
        /// <see cref="Cancel"/> may have already cleared it (nothing left to
        /// do), or a newer <see cref="Reset"/> may already have installed a
        /// fresh handle that must not be clobbered.</summary>
        public void Release(IntPtr flag)
        {
            lock (_gate)
            {
                _free(flag);
                if (_current == flag)
                    _current = IntPtr.Zero;
            }
        }
    }
}
