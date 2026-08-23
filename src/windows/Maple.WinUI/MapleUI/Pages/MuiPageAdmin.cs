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
    /// Maple.UI Admin page (unified-component-catalog.md §6 — Settings
    /// Shell template hosting Pipeline Monitor, Setup Wizard, Backup
    /// Monitor, and Diagnostics, switched by a section Nav). Windows
    /// Pages wave (#3012).
    ///
    /// Real wiring through <see cref="MuiAdminPageReducer"/>: a Pipeline
    /// Monitor stage that has already finished every unit of work can no
    /// longer be paused/resumed; the Setup Wizard's own internal gating
    /// already blocks "Finish" until every step is valid, and this page
    /// double-checks that via <see cref="MuiAdminPageReducer.CanFinish"/>
    /// before applying the result.
    /// </summary>
    public sealed class MuiPageAdmin : ContentControl
    {
        private static readonly (string Id, string Label, string IconName)[] Sections =
        {
            ("pipeline", "Pipeline", "history"),
            ("setup", "Setup Wizard", "gear"),
            ("backup", "Backup", "folder"),
            ("diagnostics", "Diagnostics", "inspector"),
        };

        private readonly MuiSettingsShell _shell = new();
        private readonly Dictionary<string, MuiListRow> _navRows = new();
        private readonly StackPanel _paneHost = new() { Orientation = Orientation.Vertical, Spacing = 12, Padding = new Thickness(24) };
        private string _activeSectionId = "pipeline";

        private readonly MuiPipelineMonitor _pipeline = new();
        private readonly MuiSetupWizard _wizard = new();
        private readonly MuiBackupMonitor _backup = new();
        private readonly MuiDiagnostics _diagnostics = new();
        private readonly MuiInput _wizardPathInput = new() { Placeholder = @"D:\Photos\Maple" };
        private readonly MuiLabelValueGrid _wizardReview = new();

        private IReadOnlyList<MuiPipelineStage> _stages = new[]
        {
            new MuiPipelineStage("thumbs", "Thumbnail generation", 850, 1000),
            new MuiPipelineStage("exif", "EXIF extraction", 1000, 1000),
            new MuiPipelineStage("faces", "Face detection", 420, 1000),
        };

        public MuiPageAdmin()
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

            _pipeline.Stages = _stages;
            _pipeline.PauseToggleRequested += (_, stageId) =>
            {
                _stages = _stages.Select(s => s.Id == stageId
                    ? s with { Paused = MuiAdminPageReducer.TogglePause(s.Paused, s.Done, s.Total) }
                    : s).ToList();
                _pipeline.Stages = _stages;
            };

            _wizardPathInput.TextChanged += (_, _) => RefreshWizardValidity();
            _wizard.Steps = new[]
            {
                new MuiWizardStepContent("welcome", "Welcome", new MuiText
                {
                    Variant = MuiTextVariant.Body,
                    Text = "This wizard configures where Maple stores your Self Hosted library.",
                }),
                new MuiWizardStepContent("path", "Storage location", _wizardPathInput),
                new MuiWizardStepContent("review", "Review", _wizardReview),
            };
            _wizard.CurrentIndex = 0;
            _wizard.StepChanged += (_, index) => { _wizard.CurrentIndex = index; RefreshWizardValidity(); };
            _wizard.Finished += (_, _) =>
            {
                if (!MuiAdminPageReducer.CanFinish(_wizard.StepValidity ?? Array.Empty<bool>())) return;
                _wizardReview.Rows = new[] { new MuiLabelValueRow("Status", "Setup complete") };
            };

            _backup.Destination = @"\\NAS\Maple\Backups";
            _backup.ProgressPercent = 100;
            _backup.StatusMessage = "Last backup 2 hours ago.";
            _backup.StatusVariant = MuiBannerVariant.Success;
            _backup.DestinationCommitted += (_, dest) => _backup.Destination = dest;
            _backup.RunNowRequested += (_, _) =>
            {
                // MuiBackupMonitor disables its own "Run now" button while
                // IsRunning is true, so a second click can't land mid-run —
                // this handler only ever sees one request at a time and
                // resolves it immediately (no timer/animation infra in
                // this wave; see docs/mockup.html for the real progress UX).
                _backup.IsRunning = true;
                _backup.ProgressPercent = 100;
                _backup.StatusMessage = $"Backup to {_backup.Destination} complete.";
                _backup.StatusVariant = MuiBannerVariant.Success;
                _backup.IsRunning = false;
            };

            _diagnostics.Checks = new[]
            {
                new MuiDiagnosticCheck("ffi", "Native pipeline (raw_ffi.dll)", MuiDiagnosticStatus.NotRun),
                new MuiDiagnosticCheck("db", "MongoDB connection", MuiDiagnosticStatus.NotRun),
                new MuiDiagnosticCheck("gpu", "GPU device (WGSL)", MuiDiagnosticStatus.NotRun),
            };
            _diagnostics.RunAllRequested += (_, _) =>
            {
                _diagnostics.IsRunning = true;
                _diagnostics.Checks = new[]
                {
                    new MuiDiagnosticCheck("ffi", "Native pipeline (raw_ffi.dll)", MuiDiagnosticStatus.Passed),
                    new MuiDiagnosticCheck("db", "MongoDB connection", MuiDiagnosticStatus.Passed),
                    new MuiDiagnosticCheck("gpu", "GPU device (WGSL)", MuiDiagnosticStatus.Failed),
                };
                _diagnostics.RawOutput = "ffi: ok (v1.6.2)\ndb: ok (mongodb://localhost:27017)\ngpu: no adapter found";
                _diagnostics.IsRunning = false;
            };

            _shell.Nav = nav;
            _shell.NavWidth = 200;
            _shell.PaneMaxWidth = 640;
            _shell.Pane = _paneHost;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            RefreshWizardValidity();
            RefreshNav();
            RefreshPane();
        }

        private void RefreshWizardValidity()
        {
            var pathValid = !string.IsNullOrWhiteSpace(_wizardPathInput.Text);
            _wizard.StepValidity = new[] { true, pathValid, true };
            _wizardReview.Rows = new[] { new MuiLabelValueRow("Storage location", string.IsNullOrWhiteSpace(_wizardPathInput.Text) ? "(not set)" : _wizardPathInput.Text) };
        }

        private void RefreshNav()
        {
            foreach (var (id, row) in _navRows)
                row.Active = id == _activeSectionId;
        }

        private void RefreshPane()
        {
            _paneHost.Children.Clear();
            UIElement section = _activeSectionId switch
            {
                "setup" => _wizard,
                "backup" => _backup,
                "diagnostics" => _diagnostics,
                _ => _pipeline,
            };
            _paneHost.Children.Add(section);
        }
    }
}
