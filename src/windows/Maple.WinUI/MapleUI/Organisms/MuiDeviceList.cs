using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One paired device.</summary>
    public sealed record MuiPairedDevice(string Id, string Name, DateTimeOffset LastSeen);

    /// <summary>
    /// Maple.UI Device List organism (unified-component-catalog.md §4.8,
    /// "Device List" row: "Paired devices with revoke", built from List
    /// Row, Dialog, Empty State) — one <see cref="MuiListRow"/> per
    /// paired device, a confirm <see cref="MuiDialog"/> before revoking,
    /// and a <see cref="MuiEmptyState"/> when nothing is paired.
    /// </summary>
    public sealed class MuiDeviceList : ContentControl
    {
        public static readonly DependencyProperty DevicesProperty =
            DependencyProperty.Register(nameof(Devices), typeof(IReadOnlyList<MuiPairedDevice>), typeof(MuiDeviceList),
                new PropertyMetadata(null, (d, _) => ((MuiDeviceList)d).Rebuild()));

        public IReadOnlyList<MuiPairedDevice>? Devices
        {
            get => (IReadOnlyList<MuiPairedDevice>?)GetValue(DevicesProperty);
            set => SetValue(DevicesProperty, value);
        }

        public event EventHandler<string>? DeviceRevoked;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly MuiEmptyState _empty = new() { IconName = "share-up-square", Title = "No paired devices" };
        private readonly MuiDialog _confirmDialog = new() { Variant = MuiDialogVariant.Confirm, Title = "Unpair this device?", ConfirmLabel = "Unpair", Destructive = true };
        private string? _pendingId;

        public MuiDeviceList()
        {
            _root.Children.Add(_rows);
            _root.Children.Add(_empty);
            _root.Children.Add(_confirmDialog);
            Content = _root;

            _confirmDialog.Confirmed += (_, _) => { _confirmDialog.IsOpen = false; if (_pendingId is not null) DeviceRevoked?.Invoke(this, _pendingId); };
            _confirmDialog.Dismissed += (_, _) => _confirmDialog.IsOpen = false;

            Rebuild();
        }

        private void Rebuild()
        {
            var devices = Devices ?? Array.Empty<MuiPairedDevice>();
            _empty.Visibility = devices.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _rows.Visibility = devices.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _rows.Children.Clear();
            var now = DateTimeOffset.Now;
            foreach (var device in devices)
            {
                var trailing = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, VerticalAlignment = VerticalAlignment.Center };
                trailing.Children.Add(new MuiTimestamp { Value = device.LastSeen, Now = now, Format = MuiTimestampFormat.Relative });
                var revoke = new MuiButton { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "Unpair" };
                var deviceId = device.Id;
                revoke.Click += (_, _) => { _pendingId = deviceId; _confirmDialog.Message = $"{device.Name} will need to pair again."; _confirmDialog.IsOpen = true; };
                trailing.Children.Add(revoke);
                _rows.Children.Add(new MuiListRow { Label = device.Name, IconName = "share-up-square", TrailingContent = trailing });
            }
        }
    }
}
