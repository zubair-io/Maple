using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One saved version of the current asset's edit state.</summary>
    public sealed record MuiAssetVersion(string Id, string Label, DateTimeOffset SavedAt, bool IsCurrent = false);

    /// <summary>
    /// Maple.UI Version History Panel organism (unified-component-catalog.md
    /// §4.3, "Version History Panel" row: "Browse and restore versions",
    /// built from List Row, Timestamp, Button, Dialog) — one
    /// <see cref="MuiListRow"/> per saved version (trailing content is a
    /// <see cref="MuiTimestamp"/> plus a Restore button, current version
    /// marked and un-restorable), gated by a confirm
    /// <see cref="MuiDialog"/> before actually restoring.
    /// </summary>
    public sealed class MuiVersionHistoryPanel : ContentControl
    {
        public static readonly DependencyProperty VersionsProperty =
            DependencyProperty.Register(nameof(Versions), typeof(IReadOnlyList<MuiAssetVersion>), typeof(MuiVersionHistoryPanel),
                new PropertyMetadata(null, (d, _) => ((MuiVersionHistoryPanel)d).Rebuild()));

        public IReadOnlyList<MuiAssetVersion>? Versions
        {
            get => (IReadOnlyList<MuiAssetVersion>?)GetValue(VersionsProperty);
            set => SetValue(VersionsProperty, value);
        }

        public event EventHandler<string>? VersionRestored;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly MuiEmptyState _empty = new() { IconName = "history", Title = "No earlier versions" };
        private readonly MuiDialog _confirmDialog = new() { Variant = MuiDialogVariant.Confirm, Title = "Restore this version?", Message = "Your current edits will be replaced.", ConfirmLabel = "Restore" };
        private string? _pendingRestoreId;

        public MuiVersionHistoryPanel()
        {
            _root.Children.Add(_rows);
            _root.Children.Add(_empty);
            _root.Children.Add(_confirmDialog);
            Content = _root;

            _confirmDialog.Confirmed += (_, _) =>
            {
                _confirmDialog.IsOpen = false;
                if (_pendingRestoreId is not null) VersionRestored?.Invoke(this, _pendingRestoreId);
            };
            _confirmDialog.Dismissed += (_, _) => _confirmDialog.IsOpen = false;

            Rebuild();
        }

        private void Rebuild()
        {
            var versions = Versions ?? Array.Empty<MuiAssetVersion>();
            _empty.Visibility = versions.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _rows.Visibility = versions.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _rows.Children.Clear();
            var now = DateTimeOffset.Now;
            foreach (var version in versions)
            {
                var trailing = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                trailing.Children.Add(new MuiTimestamp { Value = version.SavedAt, Now = now, Format = MuiTimestampFormat.Relative });
                if (!version.IsCurrent)
                {
                    var restore = new MuiButton { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "Restore" };
                    var versionId = version.Id;
                    restore.Click += (_, _) => { _pendingRestoreId = versionId; _confirmDialog.IsOpen = true; };
                    trailing.Children.Add(restore);
                }
                else
                {
                    trailing.Children.Add(new MuiBadge { Variant = MuiBadgeVariant.Signal, Value = "Current" });
                }

                _rows.Children.Add(new MuiListRow { Label = version.Label, IconName = "history", TrailingContent = trailing, Active = version.IsCurrent });
            }
        }
    }
}
