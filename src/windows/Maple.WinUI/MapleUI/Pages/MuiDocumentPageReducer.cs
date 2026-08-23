using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>One saved snapshot of a Document page's body — its own
    /// WinUI-free record (not <c>MuiAssetVersion</c>, declared in a
    /// WinUI-dependent file) so it links into Maple.WinUI.Tests.</summary>
    public sealed record MuiMockDocVersion(string Id, string Label, string Content, DateTimeOffset SavedAt, bool IsCurrent);

    /// <summary>One page in the Document page's shared fictional
    /// notebook, cross-linking into the "Ridgeline Farm Wedding"/"Iceland
    /// Roadtrip" library <see cref="MuiPageMockLibrary"/> already
    /// establishes for Browse/Editor/Search.</summary>
    public sealed record MuiMockDoc(string Id, string Label, string Content, IReadOnlyList<string> BacklinkLabels);

    /// <summary>The Document page's fixed three-page notebook.</summary>
    public static class MuiPageMockDocs
    {
        public static readonly IReadOnlyList<MuiMockDoc> All = new[]
        {
            new MuiMockDoc(
                "doc-brief", "Client Brief: Ridgeline Farm",
                "Ceremony starts 4:30pm at the barn. Reception follows at 6pm — string lights, first dance at 7. " +
                "Couple wants candid coverage over posed group shots.",
                new[] { "Ridgeline Farm Wedding shoot day" }),
            new MuiMockDoc(
                "doc-timeline", "Wedding Day Timeline",
                "2:00pm getting-ready photos. 4:30pm ceremony. 5:15pm family portraits. 6:00pm reception open. " +
                "9:30pm send-off.",
                new[] { "Client Brief: Ridgeline Farm" }),
            new MuiMockDoc(
                "doc-iceland", "Iceland Roadtrip Notes",
                "Golden hour at the black sand beach was worth the 5am wake-up. Ring road day 3 — glacier lagoon " +
                "detour added two hours but the light was unbeatable.",
                Array.Empty<string>()),
        };
    }

    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageDocument</c>'s cross-organism wiring (#3012) — the Rich
    /// Text Editor's body and the Version History Panel's snapshot list
    /// are two views of the same document. A "Save" only earns a new
    /// version when the body actually changed since the last snapshot
    /// (an unchanged save is a no-op, not a pile of identical versions);
    /// restoring a version replaces the live body and moves the "current"
    /// marker onto that version.</summary>
    public static class MuiDocumentPageReducer
    {
        public static bool ShouldSnapshot(string savedContent, string draftContent) =>
            draftContent.Trim().Length > 0 && draftContent != savedContent;

        /// <summary>Demotes every existing version's <c>IsCurrent</c> flag
        /// and appends a new current one for <paramref name="content"/>.
        /// Caller is expected to have already checked
        /// <see cref="ShouldSnapshot"/>.</summary>
        public static IReadOnlyList<MuiMockDocVersion> Snapshot(
            IReadOnlyList<MuiMockDocVersion> versions, string content, DateTimeOffset at)
        {
            var next = versions.Select(v => v with { IsCurrent = false }).ToList();
            next.Add(new MuiMockDocVersion($"v{versions.Count + 1}", $"Version {versions.Count + 1}", content, at, true));
            return next;
        }

        /// <summary>Marks <paramref name="versionId"/> current and returns
        /// its body as the next live draft. An unknown id is a no-op —
        /// the versions list and current content pass through unchanged.</summary>
        public static (IReadOnlyList<MuiMockDocVersion> Versions, string Content) Restore(
            IReadOnlyList<MuiMockDocVersion> versions, string versionId)
        {
            var target = versions.FirstOrDefault(v => v.Id == versionId);
            if (target is null)
                return (versions, versions.FirstOrDefault(v => v.IsCurrent)?.Content ?? string.Empty);

            var updated = versions.Select(v => v with { IsCurrent = v.Id == versionId }).ToList();
            return (updated, target.Content);
        }
    }
}
