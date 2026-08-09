// RevealInFileManagerLogic.cs — pure eligibility + argument-building behind
// "Show in Explorer" (#2658, mirrors the Apple sibling's "Reveal in
// Finder"). WinUI-free by construction, same reasoning as
// FolderTreeCrudLogic.cs's header comment: plain bool/string parameters
// (never PhotoItem/FolderNode directly — those types live in files that
// also carry the WinUI-dependent bulk of EditSessionViewModel/PhotoItem.cs,
// so they aren't linkable into Maple.WinUI.Tests). Links into
// Maple.WinUI.Tests via this directory's existing
// `Services\FileOperations\*.cs` wildcard Compile Include.
//
// The grid selection's eligibility rule mirrors
// EditSessionViewModel.TrashEligible exactly (`!p.IsCloud`, EditSession
// ViewModel.Trash.cs) — a Cloud photo (IsCloud true) lives on a Self-Hosted
// server, not this machine, so it has no local path Explorer could select.
// PhotoKit has no Windows equivalent; SMB items DO have a real UNC
// FilePath (the FOLDERS tree and grid both address SMB the same way local
// paths are addressed — see EditSessionViewModel.FolderCrud.cs's header:
// "this tree is 100% local Filesystem/SMB"), so they stay eligible.
//
// Multi-select: unlike macOS's `activateFileViewerSelecting`, which takes
// an array and highlights every item in one Finder window, Explorer's
// `/select,"<path>"` command line only accepts ONE path per process launch
// — there's no batch equivalent short of the `IShellFolder`/
// `SHOpenFolderAndSelectItems` COM API, which is a lot of P/Invoke surface
// for a "reveal" convenience action. The chosen behavior: reveal the FIRST
// eligible photo in the active selection (one Explorer window, one
// highlighted item) rather than spawning one Explorer process per selected
// photo.
using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.Services.FileOperations
{
    public static class RevealInFileManagerLogic
    {
        /// True for anything with a real local (or UNC/SMB) path Explorer
        /// can select — everything except a Cloud asset.
        public static bool IsEligible(bool isCloud) => !isCloud;

        /// Every eligible item's path, in selection order. Filters out
        /// Cloud items entirely rather than surfacing them disabled — the
        /// UI layer uses an empty result to HIDE the "Show in Explorer"
        /// item rather than show it non-functional.
        public static IReadOnlyList<string> EligiblePaths(IEnumerable<(string FilePath, bool IsCloud)> items) =>
            items.Where(i => IsEligible(i.IsCloud)).Select(i => i.FilePath).ToList();

        /// The single path Explorer actually reveals for a selection — the
        /// first eligible one (see file header for why "first," not "all").
        /// Null when nothing in the selection is eligible.
        public static string? RevealTarget(IEnumerable<(string FilePath, bool IsCloud)> items) =>
            EligiblePaths(items).FirstOrDefault();

        /// The `explorer.exe` command-line argument for `/select,"path"`.
        /// Single-quote around the raw path with no further escaping —
        /// Windows paths can't themselves contain `"`, so there's no
        /// argument-injection surface to guard against here.
        public static string SelectArgument(string path) => $"/select,\"{path}\"";
    }
}
