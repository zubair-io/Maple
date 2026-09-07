// CancelFlagSlotTests — #3417 Jules review. EditSessionViewModel used to
// free a decode's native cancel flag in its background task's `finally`
// without ever clearing the field that pointed at it, so a LATER, unrelated
// CancelActiveDecode() call could read that dangling pointer and call
// maple_cancel_flag_set on already-freed memory (a use-after-free), and the
// plain read-then-clear was unsynchronized against that free running
// concurrently on another thread. CancelFlagSlot centralizes both fixes
// behind one lock per handle's lifecycle; these tests exercise it with fake
// set/free delegates that detect a signal landing on an already-freed
// handle, so the exact bug class fails loudly instead of silently passing.

using System;
using System.Collections.Generic;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class CancelFlagSlotTests
    {
        /// <summary>Fake native cancel-flag surface: records every set()
        /// call and every freed handle, and throws if set() is ever called
        /// on a handle already in the freed set — the exact use-after-free
        /// shape #3417's review caught.</summary>
        private sealed class FakeNativeFlags
        {
            public readonly List<IntPtr> SetCalls = new();
            public readonly HashSet<IntPtr> Freed = new();

            public void Set(IntPtr flag)
            {
                if (Freed.Contains(flag))
                    throw new InvalidOperationException($"use-after-free: set() called on freed flag {flag}");
                SetCalls.Add(flag);
            }

            public void Free(IntPtr flag)
            {
                if (!Freed.Add(flag))
                    throw new InvalidOperationException($"double free: {flag}");
            }
        }

        [Fact]
        public void CancelSignalsTheCurrentHandleThenClearsIt()
        {
            var native = new FakeNativeFlags();
            var slot = new CancelFlagSlot(native.Set, native.Free);
            var flag = new IntPtr(1);
            slot.Reset(flag);

            slot.Cancel();
            slot.Cancel(); // nothing left to signal -- must not double-set

            Assert.Equal(new[] { flag }, native.SetCalls);
        }

        [Fact]
        public void CancelIsANoOpWhenNothingIsCurrent()
        {
            var native = new FakeNativeFlags();
            var slot = new CancelFlagSlot(native.Set, native.Free);

            slot.Cancel();

            Assert.Empty(native.SetCalls);
        }

        [Fact]
        public void ReleaseFreesTheHandleAndClearsItWhenStillCurrent()
        {
            var native = new FakeNativeFlags();
            var slot = new CancelFlagSlot(native.Set, native.Free);
            var flag = new IntPtr(1);
            slot.Reset(flag);

            slot.Release(flag);

            Assert.Contains(flag, native.Freed);
            slot.Cancel(); // the slot is now empty -- nothing to signal
            Assert.Empty(native.SetCalls);
        }

        [Fact]
        public void ReleaseDoesNotClobberAHandleANewerResetAlreadyInstalled()
        {
            // Mirrors a stale AMaZE upgrade's own cleanup running AFTER a
            // newer upgrade (or decode) already replaced the slot's handle.
            var native = new FakeNativeFlags();
            var slot = new CancelFlagSlot(native.Set, native.Free);
            var oldFlag = new IntPtr(1);
            var newFlag = new IntPtr(2);
            slot.Reset(oldFlag);
            slot.Reset(newFlag); // a newer decode/upgrade installed its own handle

            slot.Release(oldFlag); // the OLD task's own cleanup, running late

            Assert.Contains(oldFlag, native.Freed);
            Assert.DoesNotContain(newFlag, native.Freed);
            // newFlag must still be current -- Cancel() signals it, not oldFlag.
            slot.Cancel();
            Assert.Equal(new[] { newFlag }, native.SetCalls);
        }

        [Fact]
        public void CancelAfterTheTasksOwnReleaseNeverTouchesTheFreedFlag()
        {
            // The exact #3417 Jules finding: a background task frees its
            // own flag in `finally` when it finishes naturally, then a
            // LATER, unrelated CancelActiveDecode() must not signal that
            // now-freed handle.
            var native = new FakeNativeFlags();
            var slot = new CancelFlagSlot(native.Set, native.Free);
            var flag = new IntPtr(1);
            slot.Reset(flag);

            slot.Release(flag); // the decode task completed and freed its flag

            // Would throw (use-after-free, via FakeNativeFlags.Set) if
            // Cancel() still held the freed pointer and signalled it.
            var ex = Record.Exception(() => slot.Cancel());
            Assert.Null(ex);
            Assert.Empty(native.SetCalls);
            Assert.Single(native.Freed);
        }

        [Fact]
        public void TwoSlotsSharingOneLockObjectOperateIndependently()
        {
            // EditSessionViewModel's _decodeCancel and _amazeCancel share
            // one _cancelGate -- verify that only serializes access, it
            // does not conflate the two handles' lifecycles.
            var native = new FakeNativeFlags();
            var gate = new object();
            var decode = new CancelFlagSlot(native.Set, native.Free, gate);
            var amaze = new CancelFlagSlot(native.Set, native.Free, gate);
            var decodeFlag = new IntPtr(1);
            var amazeFlag = new IntPtr(2);
            decode.Reset(decodeFlag);
            amaze.Reset(amazeFlag);

            decode.Cancel();
            amaze.Cancel();

            Assert.Equal(new[] { decodeFlag, amazeFlag }, native.SetCalls);
        }
    }
}
