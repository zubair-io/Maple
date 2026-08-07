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
        /// Attempt to move <paramref name="path"/> (a file or a directory)
        /// to the Windows Recycle Bin. Returns false — never throws — on any
        /// failure, including when the Recycle Bin genuinely isn't available
        /// for that path (e.g. a network share); the caller falls back to
        /// `.maple/trash/&lt;rel&gt;` via the same relocate primitive every
        /// other move here uses.
        /// </summary>
        bool TrySendToRecycleBin(string path);
    }
}
