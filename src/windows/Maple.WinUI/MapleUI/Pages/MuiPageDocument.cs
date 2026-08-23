using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI Document page (unified-component-catalog.md §6 — Split
    /// Layout template hosting Sidebar, Rich Text Editor, Backlinks
    /// Panel, and Version History Panel). Windows Pages wave (#3012).
    ///
    /// Real cross-organism wiring: the Sidebar switches which of three
    /// shoot-notes pages is loaded into the Rich Text Editor (and its
    /// own Backlinks Panel); Save only creates a new Version History
    /// entry when the body actually changed since the last snapshot
    /// (<see cref="MuiDocumentPageReducer.ShouldSnapshot"/>) — an
    /// unchanged Save is a silent no-op, not a pile of identical
    /// versions; restoring an older version replaces the live editor
    /// body and moves the "current" marker.
    /// </summary>
    public sealed class MuiPageDocument : ContentControl
    {
        private readonly MuiSidebar _sidebar = new();
        private readonly MuiRichTextEditor _editor = new();
        private readonly MuiButton _saveButton = new() { Label = "Save", Variant = MuiButtonVariant.Primary };
        private readonly MuiStatusText _status = new() { State = MuiStatusTextState.Saved };
        private readonly MuiBacklinksPanel _backlinks = new();
        private readonly MuiVersionHistoryPanel _history = new();

        private string _activeDocId = MuiPageMockDocs.All[0].Id;
        private readonly Dictionary<string, string> _savedContent =
            MuiPageMockDocs.All.ToDictionary(d => d.Id, d => d.Content);
        private readonly Dictionary<string, IReadOnlyList<MuiMockDocVersion>> _versions =
            MuiPageMockDocs.All.ToDictionary(
                d => d.Id,
                d => (IReadOnlyList<MuiMockDocVersion>)new[]
                {
                    new MuiMockDocVersion($"{d.Id}-v1", "Version 1", d.Content, DateTimeOffset.Now.AddDays(-2), true),
                });

        public MuiPageDocument()
        {
            _sidebar.Roots = MuiPageMockDocs.All
                .Select(d => new MuiSidebarNode(d.Id, d.Label, "edit"))
                .ToList();
            _sidebar.ActiveId = _activeDocId;
            _sidebar.ItemActivated += (_, docId) => { _activeDocId = docId; LoadDoc(); };

            _editor.ValueChanged += (_, _) => RefreshStatus();

            var saveRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, VerticalAlignment = VerticalAlignment.Center };
            saveRow.Children.Add(_saveButton);
            saveRow.Children.Add(_status);
            _saveButton.Click += (_, _) => Save();

            var center = new StackPanel { Orientation = Orientation.Vertical, Spacing = 16, Padding = new Thickness(24) };
            center.Children.Add(saveRow);
            center.Children.Add(_editor);

            _backlinks.BacklinkActivated += (_, label) =>
            {
                var target = MuiPageMockDocs.All.FirstOrDefault(d => d.Label == label);
                if (target is null) return;
                _activeDocId = target.Id;
                _sidebar.ActiveId = _activeDocId;
                LoadDoc();
            };

            _history.VersionRestored += (_, versionId) =>
            {
                var (versions, content) = MuiDocumentPageReducer.Restore(_versions[_activeDocId], versionId);
                _versions[_activeDocId] = versions;
                _savedContent[_activeDocId] = content;
                _editor.Value = content;
                RefreshHistory();
                RefreshStatus();
            };

            var detail = new StackPanel { Orientation = Orientation.Vertical, Spacing = 16 };
            detail.Children.Add(_backlinks);
            detail.Children.Add(_history);

            var split = new MuiSplitLayout
            {
                Sidebar = _sidebar,
                Center = center,
                Detail = detail,
                SidebarWidth = 220,
                DetailWidth = 280,
            };
            Content = split;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            LoadDoc();
        }

        private void Save()
        {
            var draft = _editor.Value;
            if (!MuiDocumentPageReducer.ShouldSnapshot(_savedContent[_activeDocId], draft))
            {
                RefreshStatus();
                return;
            }

            _versions[_activeDocId] = MuiDocumentPageReducer.Snapshot(_versions[_activeDocId], draft, DateTimeOffset.Now);
            _savedContent[_activeDocId] = draft;
            RefreshHistory();
            RefreshStatus();
        }

        private void LoadDoc()
        {
            var doc = MuiPageMockDocs.All.First(d => d.Id == _activeDocId);
            _editor.Value = _savedContent[_activeDocId];
            _backlinks.Backlinks = doc.BacklinkLabels.Select(label => new MuiBacklink(label, label, "folder")).ToList();
            RefreshHistory();
            RefreshStatus();
        }

        private void RefreshHistory()
        {
            _history.Versions = _versions[_activeDocId]
                .Select(v => new MuiAssetVersion(v.Id, v.Label, v.SavedAt, v.IsCurrent))
                .ToList();
        }

        private void RefreshStatus()
        {
            _status.State = _editor.Value == _savedContent[_activeDocId]
                ? MuiStatusTextState.Saved
                : MuiStatusTextState.Saving;
        }
    }
}
