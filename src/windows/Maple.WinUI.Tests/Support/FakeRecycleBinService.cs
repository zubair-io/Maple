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
        public List<string> Attempts { get; } = new();

        /// <summary>When true (the default), every call succeeds and is
        /// recorded. When false, every call fails (returns false) without
        /// being recorded as a "trashed" attempt — simulating a Recycle Bin
        /// that's genuinely unavailable for the path, so callers can assert
        /// the `.maple/trash/&lt;rel&gt;` fallback engages.</summary>
        public bool Succeeds { get; set; } = true;

        public bool TrySendToRecycleBin(string path)
        {
            if (!Succeeds) return false;
            Attempts.Add(path);
            return true;
        }
    }
}
