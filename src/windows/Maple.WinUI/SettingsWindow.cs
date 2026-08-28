using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI;
using Maple.UI.Atoms;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>
    /// The app's Settings window (MN3, #3052) — the Windows shell's first
    /// settings surface, composed directly on Maple.UI:
    /// <see cref="MuiSettingsShell"/> (section nav · pane),
    /// <see cref="MuiListRow"/> nav rows, and one
    /// <see cref="MuiSettingsSection"/> per section, the same composition
    /// the catalog's Settings page demonstrates.
    ///
    /// Scope discipline (the wave's brief): every row surfaces state that
    /// already exists in code — the persisted <see cref="AppSettings"/>
    /// fields, the cloud session, the on-disk caches, and the app
    /// identity. Edits persist through <see cref="AppSettings.Update"/>
    /// (the #2948 reload-then-write invariant); actions that already have
    /// a UI (cloud connect, sidebar toggle) route through the exact
    /// MainWindow handlers that own them, passed in as callbacks.
    /// </summary>
    public sealed class SettingsWindow : Window
    {
        private static readonly (string Id, string Label, string IconName)[] Sections =
        {
            ("library", "Library", "folder"),
            ("cloud", "Maple Cloud", "cloud"),
            ("interface", "Interface", "sidebar"),
            ("pano", "Panorama", "photos"),
            ("storage", "Storage", "album-stack"),
            ("about", "About", "info"),
        };

        private static string MapleAppData => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maple");

        private readonly EditSessionViewModel _viewModel;
        private readonly Action _openCloudConnect;
        private readonly Action _toggleSidebar;

        private readonly MuiSettingsShell _shell = new() { NavWidth = 220, PaneMaxWidth = 640 };
        private readonly Dictionary<string, MuiListRow> _navRows = new();
        private readonly StackPanel _paneHost = new()
        {
            Orientation = Orientation.Vertical,
            Spacing = 16,
            Padding = new Thickness(28, 24, 28, 24),
        };
        private string _activeSectionId = "library";

        public SettingsWindow(EditSessionViewModel viewModel, Action openCloudConnect, Action toggleSidebar)
        {
            _viewModel = viewModel;
            _openCloudConnect = openCloudConnect;
            _toggleSidebar = toggleSidebar;

            Title = "Maple Settings";
            AppWindow.Resize(new Windows.Graphics.SizeInt32(1000, 720));

            var nav = new StackPanel { Orientation = Orientation.Vertical, Spacing = 2, Padding = new Thickness(12, 20, 8, 12) };
            nav.Children.Add(new MuiText
            {
                Text = "SETTINGS",
                Variant = MuiTextVariant.Eyebrow,
                Margin = new Thickness(12, 0, 0, 8),
            });
            foreach (var (id, label, iconName) in Sections)
            {
                var row = new MuiListRow { Label = label, IconName = iconName };
                var sectionId = id;
                row.Pressed += (_, _) => { _activeSectionId = sectionId; RefreshNav(); RefreshPane(); };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(row, $"{label} settings section");
                _navRows[id] = row;
                nav.Children.Add(row);
            }

            _shell.Nav = nav;
            _shell.Pane = new ScrollViewer { Content = _paneHost, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };

            var root = new Grid { Background = (Brush)Application.Current.Resources["MapleBg"] };
            root.Children.Add(_shell);
            Content = root;

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
                case "cloud": BuildCloudSection(); break;
                case "interface": BuildInterfaceSection(); break;
                case "pano": BuildPanoSection(); break;
                case "storage": BuildStorageSection(); break;
                case "about": BuildAboutSection(); break;
                default: BuildLibrarySection(); break;
            }
        }

        // --- Library ---

        private void BuildLibrarySection()
        {
            var folders = AppSettings.Load().LibraryFolders;
            var section = new MuiSettingsSection
            {
                Title = "LIBRARY FOLDERS",
                Rows = LibraryRows(folders, _ => "Checking availability…"),
            };
            _paneHost.Children.Add(section);

            if (folders.Count > 0)
            {
                // Reachability probes stay OFF the UI thread — a dead mapped
                // network root blocks Directory.Exists for tens of seconds
                // (the exact hang InitializeLibrary's own comment documents).
                var queue = DispatcherQueue;
                Task.Run(() =>
                {
                    var reachable = folders.ToDictionary(f => f, f => Directory.Exists(f));
                    queue.TryEnqueue(() => section.Rows = LibraryRows(
                        folders, f => reachable[f] ? "Available" : "Not currently reachable"));
                });
            }
            _paneHost.Children.Add(new MuiText
            {
                Text = "Folders are managed from the sidebar: + adds one, a folder's context menu removes or renames it.",
                Variant = MuiTextVariant.Body,
                ColorRole = MuiTextColorRole.Muted,
            });
        }

        private static IReadOnlyList<MuiSettingsSectionRow> LibraryRows(
            IReadOnlyList<string> folders, Func<string, string> describe) =>
            folders.Count == 0
                ? new[]
                {
                    new MuiSettingsSectionRow("none", "No library folders yet", "folder",
                        "Add a folder from the sidebar's + button (or File → Open Folder…)."),
                }
                : folders.Select((folder, i) => new MuiSettingsSectionRow(
                    $"folder-{i}", folder, "folder", describe(folder))).ToList();

        // --- Maple Cloud ---

        private void BuildCloudSection()
        {
            var settings = AppSettings.Load();
            var connect = new MuiButton { Label = "Connect to Maple Cloud…", Variant = MuiButtonVariant.Secondary };
            connect.Click += (_, _) => _openCloudConnect();

            _paneHost.Children.Add(new MuiSettingsSection
            {
                Title = "MAPLE CLOUD",
                Rows = new[]
                {
                    new MuiSettingsSectionRow("server", "Server", "cloud",
                        settings.CloudServerUrl ?? "Not configured"),
                    new MuiSettingsSectionRow("session", "Session", "person-circle",
                        _viewModel.CloudStatus),
                    new MuiSettingsSectionRow("connect", "Connection", null,
                        "Sign-in happens in your browser via the server's passkey flow; the app stores only a device refresh token, protected with Windows DPAPI.",
                        connect, StartExpanded: true),
                },
            });
        }

        // --- Interface ---

        private void BuildInterfaceSection()
        {
            var settings = AppSettings.Load();
            var sidebarToggle = new MuiCheckbox
            {
                Label = "Show the folders sidebar",
                IsThreeState = false,               // binary setting — no indeterminate stop
                CheckedState = !settings.LeftPanelHidden,
            };
            // Route through MainWindow's own toggle handler — the single
            // owner of the column width + the persisted flag (#2948) — then
            // re-sync the visual from what actually persisted.
            sidebarToggle.Click += (_, _) =>
            {
                _toggleSidebar();
                sidebarToggle.CheckedState = !AppSettings.Load().LeftPanelHidden;
            };

            _paneHost.Children.Add(new MuiSettingsSection
            {
                Title = "INTERFACE",
                Rows = new[]
                {
                    new MuiSettingsSectionRow("sidebar", "Sidebar", "sidebar",
                        "The same toggle as View → Toggle Sidebar; the choice persists across launches.",
                        sidebarToggle, StartExpanded: true),
                },
            });
        }

        // --- Panorama ---

        private void BuildPanoSection()
        {
            var settings = AppSettings.Load();

            _paneHost.Children.Add(new MuiSettingsSection
            {
                Title = "PANORAMA STITCHING",
                Rows = new[]
                {
                    PanoPathRow("pano-cli", "maple-cli path",
                        "Overrides where the pano stitcher executable is found. Empty uses maple-cli.exe beside the app.",
                        settings.PanoCliPath, (s, value) => s.PanoCliPath = value),
                    PanoPathRow("pano-models", "Models directory",
                        $@"Where the pinned ALIKED/LightGlue models are provisioned. Empty uses {Path.Combine(MapleAppData, "pano-models")}.",
                        settings.PanoModelsDir, (s, value) => s.PanoModelsDir = value),
                    PanoPathRow("pano-ort", "ONNX Runtime DLL path",
                        $@"Overrides the onnxruntime.dll the stitcher loads. Empty uses {Path.Combine(MapleAppData, "ort", "onnxruntime.dll")}.",
                        settings.PanoOrtDylibPath, (s, value) => s.PanoOrtDylibPath = value),
                },
            });
        }

        private static MuiSettingsSectionRow PanoPathRow(
            string id, string label, string description,
            string? currentValue, Action<AppSettings, string?> assign)
        {
            var input = new MuiInput
            {
                Text = currentValue ?? string.Empty,
                Placeholder = "Default",
                AccessibleLabel = label,
                HorizontalAlignment = HorizontalAlignment.Stretch,
            };
            var saved = new MuiStatusText { Visibility = Visibility.Collapsed };
            input.Committed += (_, text) =>
            {
                var value = string.IsNullOrWhiteSpace(text) ? null : text.Trim();
                try
                {
                    AppSettings.Update(s => assign(s, value));
                    saved.State = MuiStatusTextState.Saved;
                    saved.Text = value is null ? "Saved — using the default location" : "Saved";
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    // A settings-file write failure must not bubble out of a
                    // UI event handler (it would take the app down) — it
                    // becomes the row's error state instead.
                    saved.State = MuiStatusTextState.Error;
                    saved.Text = $"Couldn't save: {ex.Message}";
                }
                saved.Visibility = Visibility.Visible;
            };
            var content = new StackPanel { Orientation = Orientation.Vertical, Spacing = 6 };
            content.Children.Add(input);
            content.Children.Add(saved);
            return new MuiSettingsSectionRow(id, label, null, description, content);
        }

        // --- Storage ---

        private void BuildStorageSection()
        {
            var section = new MuiSettingsSection { Title = "STORAGE & DIAGNOSTICS" };
            section.Rows = BuildStorageRows("Measuring…");
            _paneHost.Children.Add(section);

            var queue = DispatcherQueue;
            Task.Run(() =>
            {
                var sizes = new[]
                {
                    StorageReport.TryDirectorySizeBytes(Path.Combine(MapleAppData, "thumbs")),
                    StorageReport.TryDirectorySizeBytes(Path.Combine(MapleAppData, "cloud")),
                };
                var logPath = Path.Combine(MapleAppData, "maple.log");
                long? logSize = null;
                try { if (File.Exists(logPath)) logSize = new FileInfo(logPath).Length; }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }

                queue.TryEnqueue(() => section.Rows = BuildStorageRows(null, sizes[0], sizes[1], logSize));
            });
        }

        private static IReadOnlyList<MuiSettingsSectionRow> BuildStorageRows(
            string? pendingText, long? thumbs = null, long? cloud = null, long? log = null)
        {
            // Null size = the probe couldn't measure (missing directory, or
            // unreadable/offline) — say so rather than claiming "empty";
            // an existing-but-empty directory measures as 0 B.
            string Describe(string path, long? bytes) => pendingText is not null
                ? $"{path} — {pendingText}"
                : bytes is { } b ? $"{path} — {StorageReport.FormatBytes(b)}" : $"{path} — not present (or unreadable)";

            return new[]
            {
                new MuiSettingsSectionRow("thumbs", "Thumbnail cache", "photos",
                    Describe(Path.Combine(MapleAppData, "thumbs"), thumbs)),
                new MuiSettingsSectionRow("cloud-cache", "Cloud originals & thumbnails", "cloud",
                    Describe(Path.Combine(MapleAppData, "cloud"), cloud)),
                new MuiSettingsSectionRow("log", "Diagnostics log", "info",
                    Describe(Path.Combine(MapleAppData, "maple.log"), log)),
                new MuiSettingsSectionRow("settings-file", "Settings file", "gear",
                    Path.Combine(MapleAppData, "settings.json")),
            };
        }

        // --- About ---

        private void BuildAboutSection()
        {
            var version = typeof(App).Assembly.GetName().Version?.ToString(3) ?? "unknown";
            _paneHost.Children.Add(new MuiSettingsSection
            {
                Title = "ABOUT",
                Rows = new[]
                {
                    new MuiSettingsSectionRow("version", "Maple Aperture", "info", $"Version {version}"),
                    new MuiSettingsSectionRow("app-id", "Application ID", null, "app.justmaple.aperture"),
                    new MuiSettingsSectionRow("integration", "Windows integration", null,
                        "Registered for the maple-app:// sign-in callback and RAW file types (first launch)."),
                },
            });
        }
    }
}
