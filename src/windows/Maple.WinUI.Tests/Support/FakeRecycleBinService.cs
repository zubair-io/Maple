// FakeRecycleBinService — the one fake in this test project, deliberately.
// CLAUDE.md forbids mocking the sidecar/file layer ("no mocks for the
// sidecar layer in tests... XMP is the contract; mocks let bugs through"),
// but `IRecycleBinService` wraps an OS shell call, not file/sidecar I/O —
// there is no logic inside the real `RecycleBinService` worth losing
// coverage over by faking this boundary, and a real test run must not
// silently pollute (or depend on) a developer/CI machine's actual Recycle
// Bin. See `IRecycleBinService`'s doc comment for the same reasoning.

using System.Collections.Generic;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.Tests.Support
{
    internal sealed class FakeRecycleBinService : IRecycleBinService
    {
        /// <summary>Every path passed to any single call, flattened in call
        /// order — a batched call (e.g. primary + sidecar together) records
        /// each path individually, so `Assert.Contains` against a specific
        /// path still works regardless of batching.</summary>
        public List<string> Attempts { get; } = new();

        /// <summary>Each element is the exact set of paths one call was
        /// made with, in order — lets a test assert that the primary and
        /// its sidecar were sent together as a single batched call rather
        /// than as two independent ones.</summary>
        public List<string[]> Calls { get; } = new();

        /// <summary>When true (the default), every call succeeds and is
        /// recorded. When false, every call fails (returns false) without
        /// being recorded as a "trashed" attempt — simulating a Recycle Bin
        /// that's genuinely unavailable for the path, so callers can assert
        /// the `.maple/trash/&lt;rel&gt;` fallback engages.</summary>
        public bool Succeeds { get; set; } = true;

        public bool TrySendToRecycleBin(params string[] paths)
        {
            if (!Succeeds) return false;
            Calls.Add(paths);
            Attempts.AddRange(paths);
            return true;
        }
    }
}
