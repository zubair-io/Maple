using System;
using System.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Models;

namespace Maple.WinUI.ViewModels
{
    /// <summary>One slider row in the inspector, bound to a single canonical
    /// AdjustmentState field via getter/setter lambdas.</summary>
    public partial class AdjustmentSliderViewModel : ObservableObject
    {
        private readonly Func<AdjustmentState, double> _get;
        private readonly Action<AdjustmentState, double> _set;
        private readonly Func<double, string> _format;
        private readonly EditSessionViewModel _session;
        private bool _suppress;

        public string Label { get; }
        public string AccessibleName { get; }
        public double Minimum { get; }
        public double Maximum { get; }
        public double StepFrequency { get; }
        public double DefaultValue { get; private set; }

        /// <summary>DECODE-PRODUCT field: writing it invalidates the decoded
        /// base, so the model write is held until the gesture ENDS instead of
        /// firing per tick. The per-tick path (<see cref="EditSessionViewModel
        /// .NotifyAdjustmentEdited"/>) only re-runs the GPU chain over the
        /// existing base, so it could not show these fields at all; the
        /// deferred write goes through <see cref="EditSessionViewModel
        /// .ApplyDecodeFieldEdit"/>, which re-decodes once. Mirrors the web
        /// `ToolSubParam.commitOnRelease` flag (#1153 / #3414).</summary>
        public bool CommitOnRelease { get; }

        /// <summary>The one-write-per-gesture state machine for a
        /// commit-on-release row (null for the per-tick rows, which never park
        /// anything). Owns the wheel-burst idle flush too — see
        /// <see cref="DeferredCommit"/>.</summary>
        private readonly DeferredCommit? _deferred;

        /// <summary>Backs the injected scheduler. Held so the timer is not
        /// collected before it fires, and disposed on re-arm so a superseded
        /// burst leaves nothing running.</summary>
        private Timer? _flushTimer;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(FormattedValue))]
        [NotifyPropertyChangedFor(nameof(IsModified))]
        private double _value;

        public string FormattedValue => _format(Value);
        public bool IsModified => Math.Abs(Value - DefaultValue) > 1e-6;

        /// <summary>Whether the row accepts input. Every row starts enabled;
        /// the Lens strengths (#3480) are switched per correction family to
        /// exactly what the resolved calibration covers, so a family the
        /// profile has no model for reads as inert instead of pretending.</summary>
        [ObservableProperty]
        private bool _isEnabled = true;

        [ObservableProperty]
        private string _unavailableReason = string.Empty;

        public AdjustmentSliderViewModel(
            EditSessionViewModel session, string label,
            double min, double max, double step,
            Func<AdjustmentState, double> get, Action<AdjustmentState, double> set,
            Func<double, string>? format = null, bool commitOnRelease = false, string? accessibleName = null)
        {
            _session = session;
            Label = label;
            AccessibleName = accessibleName ?? label;
            Minimum = min;
            Maximum = max;
            StepFrequency = step;
            _get = get;
            _set = set;
            _format = format ?? (v => v.ToString("0"));
            CommitOnRelease = commitOnRelease;
            DefaultValue = get(session.DefaultAdjustments());
            _value = get(session.Adjustments);
            _deferred = commitOnRelease
                ? new DeferredCommit(
                    value =>
                    {
                        if (IsEnabled)
                            _session.ApplyDecodeFieldEdit(state => _set(state, value));
                    },
                    ScheduleFlush)
                : null;
        }

        /// <summary>The `schedule` half of <see cref="DeferredCommit"/>: a
        /// one-shot timer marshalled back onto the UI thread, since the commit
        /// writes observable properties and drives a re-decode. Re-arming
        /// disposes the previous timer; `DeferredCommit`'s own generation
        /// counter is what makes a superseded callback a no-op if it already
        /// fired.</summary>
        private void ScheduleFlush(int delayMs, Action callback)
        {
            _flushTimer?.Dispose();
            _flushTimer = new Timer(
                _ => EditSessionViewModel.OnUi(callback), null, delayMs, Timeout.Infinite);
        }

        partial void OnValueChanged(double value)
        {
            if (_suppress) return;
            // UI disabling alone does not stop a queued input/automation callback.
            // Reject the write and its render/save/undo notification together.
            if (!IsEnabled)
            {
                SyncFromModel();
                return;
            }
            if (_deferred is not null)
            {
                // Park it: the value chip and the modified dot read `Value`,
                // not the model, so the row still tracks the drag live while
                // the expensive re-decode waits for the release.
                _deferred.Park(value);
                return;
            }
            _set(_session.Adjustments, value);
            _session.NotifyAdjustmentEdited();
        }

        /// <summary>Flush a parked commit-on-release value as the single model
        /// write of the whole gesture. Called from the slider row's
        /// pointer-capture-lost / key-up handlers; a no-op for every per-tick
        /// row, which never parks anything.</summary>
        public void CommitDeferred()
        {
            if (!IsEnabled) _deferred?.Discard();
            else _deferred?.Flush();
        }

        /// <summary>A mouse-wheel detent over the row. The wheel raises neither
        /// `PointerCaptureLost` nor `KeyUp`, so without this a wheel-adjusted
        /// value would stay parked forever and the edit would be lost on
        /// navigate. The burst commits once, `WheelIdleFlushMs` after the last
        /// detent — one gesture, one undo entry, matching the web editor.</summary>
        public void NotifyWheelTick() => _deferred?.WheelTick();

        /// <summary>Refresh from the model without echoing back (sidecar reload,
        /// preset apply, undo). Drops any parked value: the model it would have
        /// been written onto is gone.</summary>
        public void SyncFromModel()
        {
            _suppress = true;
            _deferred?.Discard();
            RefreshDefaultValue();
            Value = _get(_session.Adjustments);
            _suppress = false;
        }

        internal void RefreshDefaultValue()
        {
            DefaultValue = _get(_session.DefaultAdjustments());
            OnPropertyChanged(nameof(DefaultValue));
            OnPropertyChanged(nameof(IsModified));
        }

        /// <summary>Double-tap reset per the drag-bar spec. A reset is an
        /// explicit, discrete edit, so it writes through immediately even on a
        /// commit-on-release row — the assignment parks the default, and the
        /// flush below is what lands it (and no-ops when the row was already
        /// at its default, so nothing was parked).</summary>
        public void Reset()
        {
            Value = DefaultValue;
            CommitDeferred();
        }

        internal void ResetModelValue(AdjustmentState model) => _set(model, DefaultValue);
    }
}
