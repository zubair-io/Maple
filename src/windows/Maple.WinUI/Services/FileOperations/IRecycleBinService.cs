// IRecycleBinService.cs — abstraction over the real Windows Recycle Bin
// (issue #2632), so `LocalFileOperations`'s trash paths can be exercised in
// tests without touching a real user's Recycle Bin or depending on a
// Windows-only shell32 P/Invoke actually being callable in CI. The OS API
// itself (`RecycleBinService`) has no logic worth unit-testing on its own —
// it is a single call into the shell — so faking THIS boundary (not the
// sidecar/file layer, which CLAUDE.md forbids mocking) is the right seam.

namespace Maple.WinUI.Services.FileOperations
{
    public interface IRecycleBinService
    {
        /// <summary>
        /// Attempt to move every path in <paramref name="paths"/> (files or
        /// directories) to the Windows Recycle Bin as ONE shell call, not
        /// one call per path — an asset's primary and its sidecar are passed
        /// together so they succeed or fail as a unit rather than risking a
        /// window where the primary lands in the Recycle Bin and the
        /// sidecar doesn't (or vice versa). A single path is just a
        /// one-element batch. Returns false — never throws — on any
        /// failure, including when the Recycle Bin genuinely isn't
        /// available for that path (e.g. a network share); the caller falls
        /// back to `.maple/trash/&lt;rel&gt;` via the same relocate
        /// primitive every other move here uses.
        /// </summary>
        bool TrySendToRecycleBin(params string[] paths);
    }
}
