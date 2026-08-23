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
    /// Maple.UI Settings page (unified-component-catalog.md §6 —
    /// Settings Shell template hosting Settings Section, Device List, and
    /// User Management, switched by a section Nav). Windows Pages wave
    /// (#3012).
    ///
    /// Real wiring: the Nav list swaps the Pane's content between three
    /// sections; the Team section's invite form only accepts a
    /// well-formed email (<see cref="MuiSettingsPageReducer.IsValidInvite"/>)
    /// — an invalid one surfaces an inline error Banner instead of
    /// silently adding a broken row; revoking a device or a user removes
    /// it from that section's live list.
    /// </summary>
    public sealed class MuiPageSettings : ContentControl
    {
        private static readonly (string Id, string Label, string IconName)[] Sections =
        {
            ("general", "General", "gear"),
            ("devices", "Devices", "photos"),
            ("team", "Team", "person-circle"),
        };

        private readonly MuiSettingsShell _shell = new();
        private readonly Dictionary<string, MuiListRow> _navRows = new();
        private readonly MuiSettingsSection _general = new();
        private readonly MuiDeviceList _devices = new();
        private readonly MuiUserManagement _users = new();
        private readonly MuiBanner _inviteBanner = new() { Dismissible = true, Visibility = Visibility.Collapsed };
        private readonly StackPanel _paneHost = new() { Orientation = Orientation.Vertical, Spacing = 12, Padding = new Thickness(24) };

        private IReadOnlyList<MuiPairedDevice> _deviceList = new[]
        {
            new MuiPairedDevice("d1", "Zubair's MacBook Pro", DateTimeOffset.Now.AddMinutes(-4)),
            new MuiPairedDevice("d2", "Studio iPad Pro", DateTimeOffset.Now.AddDays(-1)),
            new MuiPairedDevice("d3", "Living Room Apple TV", DateTimeOffset.Now.AddDays(-6)),
        };
        private IReadOnlyList<MuiManagedUser> _userList = new[]
        {
            new MuiManagedUser("u1", "Zubair Lawrence", "Owner"),
            new MuiManagedUser("u2", "Priya Nair", "Editor"),
        };
        private string _activeSectionId = "general";

        public MuiPageSettings()
        {
            var nav = new StackPanel { Orientation = Orientation.Vertical, Spacing = 2 };
            foreach (var section in Sections)
            {
                var row = new MuiListRow { Label = section.Label, IconName = section.IconName };
                var id = section.Id;
                row.Pressed += (_, _) => { _activeSectionId = id; RefreshNav(); RefreshPane(); };
                _navRows[section.Id] = row;
                nav.Children.Add(row);
            }

            _general.Title = "General";
            _general.Rows = new[]
            {
                new MuiSettingsSectionRow("app-name", "Application", null, "app.justmaple.aperture"),
                new MuiSettingsSectionRow("storage", "Local library path", null, @"D:\Photos\Maple"),
            };

            _devices.Devices = _deviceList;
            _devices.DeviceRevoked += (_, id) => { _deviceList = _deviceList.Where(d => d.Id != id).ToList(); _devices.Devices = _deviceList; };

            _users.Users = _userList;
            _users.UserRevoked += (_, id) => { _userList = _userList.Where(u => u.Id != id).ToList(); _users.Users = _userList; };
            _users.InviteRequested += (_, email) =>
            {
                if (!MuiSettingsPageReducer.IsValidInvite(email))
                {
                    _inviteBanner.Variant = MuiBannerVariant.Error;
                    _inviteBanner.Message = $"\"{email}\" doesn't look like a valid email address.";
                    _inviteBanner.Visibility = Visibility.Visible;
                    return;
                }

                _userList = _userList.Append(new MuiManagedUser($"u{_userList.Count + 1}", email, "Viewer")).ToList();
                _users.Users = _userList;
                _users.InvitePayload = string.Empty;
                _inviteBanner.Variant = MuiBannerVariant.Success;
                _inviteBanner.Message = $"Invited {email}.";
                _inviteBanner.Visibility = Visibility.Visible;
            };
            _inviteBanner.Dismissed += (_, _) => _inviteBanner.Visibility = Visibility.Collapsed;
            _inviteBanner.ActionPressed += (_, _) => _inviteBanner.Visibility = Visibility.Collapsed;

            _shell.Nav = nav;
            _shell.NavWidth = 200;
            _shell.PaneMaxWidth = 640;
            _shell.Pane = _paneHost;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            RefreshNav();
            RefreshPane();
        }

        private void RefreshNav()
        {
            foreach (var (id, row) in _navRows)
                row.Active = id == _activeSectionId;
        }

        private void RefreshPane()
        {
            _paneHost.Children.Clear();
            switch (_activeSectionId)
            {
                case "devices":
                    _paneHost.Children.Add(_devices);
                    break;
                case "team":
                    _paneHost.Children.Add(_inviteBanner);
                    _paneHost.Children.Add(_users);
                    break;
                default:
                    _paneHost.Children.Add(_general);
                    break;
            }
        }
    }
}
