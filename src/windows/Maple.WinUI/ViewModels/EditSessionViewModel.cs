using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    /// <summary>
    /// Per-session editing state: the selected photo's decoded scene-linear
    /// base, the canonical AdjustmentState, the render loop, debounced XMP
    /// sidecar persistence, and the undo stack. Library concerns live in the
    /// EditSessionViewModel.Library.cs partial.
    /// </summary>
    public partial class EditSessionViewModel : ObservableObject, IDisposable
    {
        public const int DefaultPreviewLongEdge = 1600;

        /// <summary>Decode long edge for the Edit session. MAPLE_DECODE_LONG_EDGE
        /// overrides for perf experiments (#2587) — e.g. the qualification
        /// harness measuring how tick cost scales with session pixels.</summary>
        public static readonly int PreviewLongEdge = ResolvePreviewLongEdge();

        private static int ResolvePreviewLongEdge()
        {
            var raw = Environment.GetEnvironmentVariable("MAPLE_DECODE_LONG_EDGE");
            if (string.IsNullOrEmpty(raw))
                return DefaultPreviewLongEdge;
            if (int.TryParse(raw, out var v) && v is >= 256 and <= 8192)
            {
                DiagLog.Write($"[decode] MAPLE_DECODE_LONG_EDGE override active: {v}");
                return v;
            }
            DiagLog.Write($"[decode] MAPLE_DECODE_LONG_EDGE ignored (invalid: '{raw}')");
            return DefaultPreviewLongEdge;
        }
        private const int SidecarDebounceMs = 750;
        private const int UndoCommitQuietMs = 450;
        private const int UndoDepth = 50;

        public AdjustmentState Adjustments { get; private set; } = new();
        public List<AdjustmentSectionViewModel> Sections { get; }
        public List<HslBandViewModel> HslBands { get; }
        public List<GradeZoneViewModel> GradeZones { get; }

        /// <summary>Raised after the whole view layer resynced from the model
        /// (photo open, undo/redo, sidecar reload) — code-built controls that
        /// don't ride slider VMs (wheels, curve plot) refresh on this.</summary>
        public event Action? ModelSynced;
        public RenderScheduler Renderer { get; } = new();

        private readonly SidecarWatcher _sidecarWatcher = new();
        private readonly List<AdjustmentState> _undoStack = new();
        private readonly List<AdjustmentState> _redoStack = new();
        private AdjustmentState? _originalModel;
        private AdjustmentState? _undoBaseline;
        private Timer? _sidecarTimer;
        private Timer? _undoTimer;
        private IntPtr _decodeCancelFlag = IntPtr.Zero;
        private int _decodeGeneration;
        private string? _lastSidecarWriteText;
        /// <summary>The photo whose adjustments are currently loaded — the only
        /// photo a sidecar write may target. SelectedPhoto already points at the
        /// NEXT photo while the previous session is being flushed.</summary>
        private PhotoItem? _openPhoto;
        private bool _sidecarDirty;
        private float _asShotTemperature = 6500f;
        private float _asShotTint;
        /// <summary>The photo the scene-linear decode has run (or is running)
        /// for — decode is lazy and only starts on Edit entry.</summary>
        private PhotoItem? _decodedPhoto;

        [ObservableProperty]
        private PhotoItem? _selectedPhoto;

        [ObservableProperty]
        private bool _isDecoding;

        [ObservableProperty]
        private string _decodeStatus = string.Empty;

        [ObservableProperty]
        private double _lastRenderMillis;

        /// <summary>B&W conversion toggle (crs:ConvertToGrayscale). When On the
        /// gray-mixer weights drive luminance and the HSL sliders go inert.</summary>
        public bool BlackWhiteOn
        {
            get => Adjustments.BlackWhite == ToggleMode.On;
            set
            {
                if (BlackWhiteOn == value)
                    return;
                Adjustments.BlackWhite = value ? ToggleMode.On : ToggleMode.Off;
                OnPropertyChanged();
                NotifyAdjustmentEdited();
            }
        }

        public EditSessionViewModel()
        {
            Sections = AdjustmentSections.Build(this);
            HslBands = AdjustmentSections.BuildHslBands(this);
            GradeZones = AdjustmentSections.BuildGradeZones(this);
            _sidecarWatcher.SidecarChangedOnDisk += OnSidecarChangedOnDisk;
            InitializeLibrary();

            _ = RestoreCloudSessionAsync();
        }

        // --- Open / decode ---

        partial void OnSelectedPhotoChanged(PhotoItem? value)
        {
            LensProfileFacts = null;
            LensProfileInfo = "Lens correction data has not been assessed.";
            if (value != null)
                OpenForEditing(value);
        }

        private void OpenForEditing(PhotoItem photo)
        {
            FlushSidecarNow();
            PublishPendingCloudPreview();
            _openPhoto = photo;
            _sidecarDirty = false;
            _decodedPhoto = null;
            CancelActiveDecode();
            // Never let a stale image produce frames for the new photo; the
            // Preview screen shows the embedded JPEG until Edit decodes.
            Renderer.SetImage(null);
            IsDecoding = false;
            DecodeStatus = string.Empty;

            if (photo.IsCloud)
            {
                // Cloud assets: culling state came from the search feed; the
                // full adjustment sidecar is fetched from the server (with
                // passthrough intact, so our full-document POST on flush never
                // drops server-side metadata). The original downloads lazily on
                // Edit entry (#2588 download-to-edit).
                Adjustments = new AdjustmentState();
                _originalModel = Adjustments.Clone();
                _undoBaseline = Adjustments.Clone();
                _undoStack.Clear();
                _redoStack.Clear();
                SyncSlidersFromModel();
                _cloudDoc = null;
                RequestCloudPreview(photo);
                _ = LoadCloudSidecarAsync(photo);
                return;
            }

            var doc = SidecarStore.Load(photo.FilePath);
            Adjustments = doc?.Adjustments ?? new AdjustmentState();
            _originalModel = Adjustments.Clone();
            _undoBaseline = Adjustments.Clone();
            _undoStack.Clear();
            _redoStack.Clear();
            SyncSlidersFromModel();

            _sidecarWatcher.WatchDirectory(System.IO.Path.GetDirectoryName(photo.FilePath) ?? string.Empty);
            RequestEmbeddedPreview(photo);
        }

        /// <summary>Extract the full-screen embedded JPEG for the Preview
        /// screen (cached; instant after first visit).</summary>
        private void RequestEmbeddedPreview(PhotoItem photo)
        {
            if (photo.PreviewPath != null)
                return;
            _ = Task.Run(async () =>
            {
                var path = await _thumbnails.GetOrCreateAsync(
                    photo.FilePath, CancellationToken.None, ThumbnailService.PreviewMaxPx);
                if (path != null)
                    OnUi(() => photo.PreviewPath = new Uri(path).AbsoluteUri);
            });
        }

        /// <summary>Start the scene-linear decode for the current photo if it
        /// has not run yet — called when the Edit screen is entered. The
        /// embedded-JPEG preview stays on screen until the first chain frame.</summary>
        public void EnsureDecoded()
        {
            var photo = SelectedPhoto;
            if (photo == null || ReferenceEquals(_decodedPhoto, photo))
                return;
            if (photo.IsCloud && photo.LocalCachePath == null)
            {
                _ = DownloadThenDecodeAsync(photo);
                return;
            }
            _decodedPhoto = photo;
            DecodeCurrent(photo);
        }

        /// <summary>Re-run the scene-linear decode for the current model without
        /// resetting the undo stack (used at open and when a decode-owned field
        /// like AutoExposure changes).</summary>
        private void DecodeCurrent(PhotoItem photo)
        {
            LensProfileFacts = null;
            var generation = Interlocked.Increment(ref _decodeGeneration);
            CancelActiveDecode();

            IsDecoding = true;
            DecodeStatus = $"Decoding {photo.FileName}…";
            var cancelFlag = RawFfi.maple_cancel_flag_new();
            _decodeCancelFlag = cancelFlag;
            var model = Adjustments.Clone();
            _ = Task.Run(() =>
            {
                try
                {
                    var decoded = RenderEngine.Decode(
                        photo.EditPath, model, PreviewLongEdge, cancelFlag);
                    if (generation != _decodeGeneration)
                        return;
                    Renderer.SetImage(decoded);
                    OnUi(() => ApplyDecodedState(generation, photo, decoded));
                }
                catch (Exception ex)
                {
                    if (generation == _decodeGeneration)
                        OnUi(() => { IsDecoding = false; DecodeStatus = $"Decode failed: {ex.Message}"; });
                }
                finally
                {
                    RawFfi.maple_cancel_flag_free(cancelFlag);
                }
            });
        }

        private void CancelActiveDecode()
        {
            var flag = _decodeCancelFlag;
            _decodeCancelFlag = IntPtr.Zero;
            if (flag != IntPtr.Zero)
                RawFfi.maple_cancel_flag_set(flag);
        }

        // --- Adjustment edits ---

        /// <summary>Called by every slider on value change: re-render, debounce
        /// the sidecar write (750ms per spec), debounce the undo commit.</summary>
        public void NotifyAdjustmentEdited()
        {
            Renderer.RequestRender(Adjustments.Clone());
            ScheduleSidecarWrite();
            _undoTimer?.Dispose();
            _undoTimer = new Timer(_ => OnUi(CommitUndoBoundary), null, UndoCommitQuietMs, Timeout.Infinite);
        }

        private void CommitUndoBoundary()
        {
            if (_undoBaseline == null)
                return;
            _undoStack.Add(_undoBaseline);
            if (_undoStack.Count > UndoDepth)
                _undoStack.RemoveAt(0);
            _redoStack.Clear();
            _undoBaseline = Adjustments.Clone();
        }

        public void Undo()
        {
            if (_undoStack.Count == 0)
                return;
            var before = Adjustments;
            _redoStack.Add(Adjustments.Clone());
            Adjustments = _undoStack[^1];
            _undoStack.RemoveAt(_undoStack.Count - 1);
            _undoBaseline = Adjustments.Clone();
            AfterModelReplaced(before);
        }

        public void Redo()
        {
            if (_redoStack.Count == 0)
                return;
            var before = Adjustments;
            _undoStack.Add(Adjustments.Clone());
            Adjustments = _redoStack[^1];
            _redoStack.RemoveAt(_redoStack.Count - 1);
            _undoBaseline = Adjustments.Clone();
            AfterModelReplaced(before);
        }

        /// <summary>RESET: back to canonical defaults with WB at the as-shot
        /// identity. Pushes the current state so it is undoable.</summary>
        public void ResetToDefaults()
        {
            var before = Adjustments;
            _undoStack.Add(Adjustments.Clone());
            Adjustments = new AdjustmentState
            {
                Temperature = _asShotTemperature,
                Tint = _asShotTint,
            };
            _undoBaseline = Adjustments.Clone();
            AfterModelReplaced(before);
        }

        /// <summary>Revert is not undo: pushes current onto the undo stack then
        /// restores the model loaded at open.</summary>
        public void RevertToOriginal()
        {
            if (_originalModel == null)
                return;
            var before = Adjustments;
            _undoStack.Add(Adjustments.Clone());
            Adjustments = _originalModel.Clone();
            _undoBaseline = Adjustments.Clone();
            AfterModelReplaced(before);
        }

        /// <summary>AUTO (WB preset row): the recommendation's exposure REPLACES
        /// the AE anchor, so AutoExposure must be set Off with it.</summary>
        public void ApplyAuto()
        {
            var photo = SelectedPhoto;
            if (photo == null)
                return;
            _ = Task.Run(() =>
            {
                var rc = RawFfi.maple_compute_auto_adjustments(
                    photo.FilePath, ExistingSidecar(photo.FilePath), 1, out var auto);
                if (rc != 0)
                {
                    System.Diagnostics.Debug.WriteLine($"[Auto] rc={rc}: {RawFfi.LastError()}");
                    return;
                }
                OnUi(() =>
                {
                    CommitUndoBoundary();
                    var before = Adjustments.Clone();
                    Adjustments.Exposure = auto.exposure;
                    Adjustments.AutoExposure = ToggleMode.Off;
                    Adjustments.Temperature = auto.temperature;
                    Adjustments.Tint = auto.tint;
                    Adjustments.Contrast = auto.contrast;
                    Adjustments.Highlights = auto.highlights;
                    Adjustments.Shadows = auto.shadows;
                    Adjustments.Whites = auto.whites;
                    Adjustments.Blacks = auto.blacks;
                    AfterModelReplaced(before);
                });
            });
        }

        private void SyncSlidersFromModel()
        {
            foreach (var slider in Sections.SelectMany(s => s.Sliders))
                slider.SyncFromModel();
            foreach (var band in HslBands)
            {
                band.Hue.SyncFromModel();
                band.Sat.SyncFromModel();
                band.Lum.SyncFromModel();
            }
            foreach (var zone in GradeZones)
                zone.SyncFromModel();
            OnPropertyChanged(nameof(BlackWhiteOn));
            ModelSynced?.Invoke();
        }

        // --- Sidecar persistence (debounced, non-destructive) ---

        private void ScheduleSidecarWrite()
        {
            _sidecarDirty = true;
            _sidecarTimer?.Dispose();
            _sidecarTimer = new Timer(_ => FlushSidecarNow(), null, SidecarDebounceMs, Timeout.Infinite);
        }

        private void FlushSidecarNow()
        {
            var photo = _openPhoto;
            if (photo == null || !_sidecarDirty)
                return;
            _sidecarDirty = false;
            if (photo.IsCloud)
            {
                PushCloudSidecar(photo);
                return;
            }
            try
            {
                var doc = new XmpSidecarDocument
                {
                    Adjustments = Adjustments.Clone(),
                    Rating = photo.Rating,
                    Flag = photo.FlagStatus,
                    ColorLabel = photo.ColorLabel,
                };
                _lastSidecarWriteText = XmpWriter.Serialize(doc);
                SidecarStore.Save(photo.FilePath, doc);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Sidecar] write failed: {ex.Message}");
            }
        }

        private void OnSidecarChangedOnDisk(object? sender, string path)
        {
            var photo = SelectedPhoto;
            if (photo == null)
                return;
            if (!string.Equals(path, SidecarStore.SidecarPathFor(photo.FilePath),
                    StringComparison.OrdinalIgnoreCase))
                return;
            try
            {
                var text = System.IO.File.ReadAllText(path);
                if (text == _lastSidecarWriteText)
                    return;  // our own debounced write echoing back
                var doc = XmpParser.Parse(text);
                if (doc == null) return;
                OnUi(() =>
                {
                    if (!ReferenceEquals(photo, SelectedPhoto)) return;
                    var before = Adjustments;
                    Adjustments = doc.Adjustments;
                    photo.Rating = doc.Rating ?? 0;
                    photo.FlagStatus = doc.Flag ?? "none";
                    photo.ColorLabel = doc.ColorLabel;
                    SyncSlidersFromModel();
                    RefreshRenderAfterModelChange(before);
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Sidecar] external reload failed: {ex.Message}");
            }
        }

        // --- Culling (undo commit boundary = the keystroke itself) ---

        public void SetRating(int stars)
        {
            var photo = SelectedPhoto;
            if (photo == null || stars < 0 || stars > 5)
                return;
            photo.Rating = stars;
            PersistCulling(photo);
        }

        public void SetFlag(string flag)
        {
            var photo = SelectedPhoto;
            if (photo == null)
                return;
            photo.FlagStatus = flag;
            PersistCulling(photo);
        }

        public void SetColorLabel(string? label)
        {
            var photo = SelectedPhoto;
            if (photo == null)
                return;
            photo.ColorLabel = label;
            PersistCulling(photo);
        }

        private void PersistCulling(PhotoItem photo)
        {
            if (photo.IsCloud)
                PushCloudCulling(photo);
            else
                ScheduleSidecarWrite();
        }

        private static string? ExistingSidecar(string rawPath)
        {
            var path = SidecarStore.SidecarPathFor(rawPath);
            return System.IO.File.Exists(path) ? path : null;
        }

        private static void OnUi(Action action)
        {
            var queue = App.MainDispatcherQueue;
            if (queue == null || queue.HasThreadAccess)
                action();
            else
                queue.TryEnqueue(() => action());
        }

        public void Dispose()
        {
            CancelActiveDecode();
            _sidecarTimer?.Dispose();
            _undoTimer?.Dispose();
            _sidecarWatcher.Dispose();
            _libraryWatcher?.Dispose();
            Renderer.Dispose();
        }
    }
}
