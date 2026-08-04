using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Native;

namespace Maple.WinUI.ViewModels
{
    public class PhotoItem
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string FilePath { get; set; } = string.Empty;
        public string FileName { get; set; } = string.Empty;
        public string Format { get; set; } = "DNG";
        public string Dimensions { get; set; } = "RAW Image";
        public string RatingStars { get; set; } = "★★★★★";
        public string CameraModel { get; set; } = "RAW Source";
        public string LensInfo { get; set; } = string.Empty;
        public string Iso { get; set; } = "ISO 100";
        public string Aperture { get; set; } = "f/2.8";
        public string ShutterSpeed { get; set; } = "1/500s";
        public string DateTaken { get; set; } = string.Empty;

        public string ThumbnailUri
        {
            get
            {
                if (string.IsNullOrEmpty(FilePath) || !File.Exists(FilePath))
                    return string.Empty;
                try
                {
                    return new Uri(FilePath).AbsoluteUri;
                }
                catch
                {
                    return string.Empty;
                }
            }
        }
    }

    public partial class EditSessionViewModel : ObservableObject
    {
        [ObservableProperty]
        private bool _isBrowseMode = true;

        [ObservableProperty]
        private bool _isDevelopMode = false;

        [ObservableProperty]
        private string _activeSectionName = "All Photos";

        [ObservableProperty]
        private string _currentFolderPath = string.Empty;

        [ObservableProperty]
        private bool _hasPhotos = false;

        // --- Tone Controls ---
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(ExposureFormatted))]
        private float _exposure = 0.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(ContrastFormatted))]
        private float _contrast = 0.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(HighlightsFormatted))]
        private float _highlights = 0.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(ShadowsFormatted))]
        private float _shadows = 0.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(WhitesFormatted))]
        private float _whites = 0.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(BlacksFormatted))]
        private float _blacks = 0.0f;

        // --- Color & White Balance ---
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(TemperatureFormatted))]
        private float _temperature = 5500.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(TintFormatted))]
        private float _tint = 0.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(VibranceFormatted))]
        private float _vibrance = 0.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(SaturationFormatted))]
        private float _saturation = 0.0f;

        // --- Scene Effects & Detail ---
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(TextureFormatted))]
        private float _texture = 0.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(DehazeFormatted))]
        private float _dehaze = 0.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(SharpenAmountFormatted))]
        private float _sharpenAmount = 40.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(NoiseReductionLumaFormatted))]
        private float _noiseReductionLuma = 0.0f;

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(NoiseReductionColorFormatted))]
        private float _noiseReductionColor = 25.0f;

        // --- Formatted Property Getters ---
        public string ExposureFormatted => $"{Exposure:F2} EV";
        public string ContrastFormatted => $"{Contrast:F0}";
        public string HighlightsFormatted => $"{Highlights:F0}";
        public string ShadowsFormatted => $"{Shadows:F0}";
        public string WhitesFormatted => $"{Whites:F0}";
        public string BlacksFormatted => $"{Blacks:F0}";
        public string TemperatureFormatted => $"{Temperature:F0} K";
        public string TintFormatted => $"{Tint:F0}";
        public string VibranceFormatted => $"{Vibrance:F0}";
        public string SaturationFormatted => $"{Saturation:F0}";
        public string TextureFormatted => $"{Texture:F0}";
        public string DehazeFormatted => $"{Dehaze:F0}";
        public string SharpenAmountFormatted => $"{SharpenAmount:F0}";
        public string NoiseReductionLumaFormatted => $"{NoiseReductionLuma:F0}";
        public string NoiseReductionColorFormatted => $"{NoiseReductionColor:F0}";

        [ObservableProperty]
        private PhotoItem? _selectedPhoto;

        public ObservableCollection<PhotoItem> Photos { get; } = new();
        public ObservableCollection<string> KnownFolderPaths { get; } = new();

        public EditSessionViewModel()
        {
            string defaultPictures = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
            if (Directory.Exists(defaultPictures) && GetImageFiles(defaultPictures).Any())
            {
                LoadDirectory(defaultPictures);
            }
            else
            {
                string testRawsPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "..", "..", "src", "raw-pipeline", "test-fixtures", "raws");
                if (Directory.Exists(testRawsPath) && GetImageFiles(testRawsPath).Any())
                {
                    LoadDirectory(testRawsPath);
                }
            }
        }

        private static readonly HashSet<string> SupportedExtensions = new(StringComparer.OrdinalIgnoreCase)
        {
            ".dng", ".arw", ".cr3", ".cr2", ".nef", ".orf", ".rw2", ".pef", ".raf", ".srw",
            ".tif", ".tiff", ".jpg", ".jpeg", ".png", ".webp", ".bmp"
        };

        private IEnumerable<string> GetImageFiles(string folderPath)
        {
            try
            {
                return Directory.EnumerateFiles(folderPath, "*.*", SearchOption.TopDirectoryOnly)
                                .Where(f => SupportedExtensions.Contains(Path.GetExtension(f)));
            }
            catch
            {
                return Enumerable.Empty<string>();
            }
        }

        public void LoadDirectory(string folderPath)
        {
            if (string.IsNullOrWhiteSpace(folderPath) || !Directory.Exists(folderPath))
                return;

            CurrentFolderPath = folderPath;
            ActiveSectionName = Path.GetFileName(folderPath);
            if (string.IsNullOrEmpty(ActiveSectionName))
                ActiveSectionName = folderPath;

            if (!KnownFolderPaths.Contains(folderPath))
            {
                KnownFolderPaths.Add(folderPath);
            }

            Photos.Clear();

            var imageFiles = GetImageFiles(folderPath).ToList();

            foreach (var filePath in imageFiles)
            {
                try
                {
                    var fileInfo = new FileInfo(filePath);
                    string ext = fileInfo.Extension;
                    string formatName = string.IsNullOrEmpty(ext) ? "RAW" : ext.TrimStart('.').ToUpperInvariant();
                    string sizeMb = (fileInfo.Length / (1024.0 * 1024.0)).ToString("F1") + " MB";

                    Photos.Add(new PhotoItem
                    {
                        FilePath = filePath,
                        FileName = fileInfo.Name,
                        Format = formatName,
                        Dimensions = $"{sizeMb} • {formatName}",
                        DateTaken = fileInfo.LastWriteTime.ToString("yyyy-MM-dd HH:mm"),
                        RatingStars = "★★★★★",
                        CameraModel = $"{formatName} Image",
                        LensInfo = fileInfo.DirectoryName ?? string.Empty,
                        Iso = sizeMb,
                        Aperture = "f/2.8",
                        ShutterSpeed = "1/250s"
                    });
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"Failed to load file info for {filePath}: {ex.Message}");
                }
            }

            HasPhotos = Photos.Count > 0;
            if (HasPhotos)
            {
                SelectedPhoto = Photos[0];
            }
            else
            {
                SelectedPhoto = null;
            }
        }

        public void SwitchToBrowseMode()
        {
            IsBrowseMode = true;
            IsDevelopMode = false;
        }

        public void SwitchToDevelopMode()
        {
            IsBrowseMode = false;
            IsDevelopMode = true;
        }

        public RawPipelineNative.MapleAdjustmentParams GetCurrentAdjustmentParams()
        {
            return new RawPipelineNative.MapleAdjustmentParams
            {
                Exposure = Exposure,
                Contrast = Contrast,
                Highlights = Highlights,
                Shadows = Shadows,
                Whites = Whites,
                Blacks = Blacks,
                Temperature = Temperature,
                Tint = Tint,
                Vibrance = Vibrance,
                Saturation = Saturation,
                Texture = Texture,
                Dehaze = Dehaze,
                SharpenAmount = SharpenAmount,
                NoiseReductionLuma = NoiseReductionLuma,
                NoiseReductionColor = NoiseReductionColor
            };
        }
    }
}
