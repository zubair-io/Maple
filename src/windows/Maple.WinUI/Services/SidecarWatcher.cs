using System;
using System.IO;

namespace Maple.WinUI.Services
{
    public class SidecarWatcher : IDisposable
    {
        private FileSystemWatcher? _watcher;

        public event EventHandler<string>? SidecarChangedOnDisk;

        public void WatchDirectory(string folderPath)
        {
            Stop();

            if (string.IsNullOrWhiteSpace(folderPath) || !Directory.Exists(folderPath))
                return;

            _watcher = new FileSystemWatcher(folderPath, "*.xmp")
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
                EnableRaisingEvents = true
            };

            _watcher.Changed += OnFileSystemEvent;
            _watcher.Created += OnFileSystemEvent;
            _watcher.Renamed += OnFileSystemEvent;
        }

        private void OnFileSystemEvent(object sender, FileSystemEventArgs e)
        {
            SidecarChangedOnDisk?.Invoke(this, e.FullPath);
        }

        public void Stop()
        {
            if (_watcher != null)
            {
                _watcher.EnableRaisingEvents = false;
                _watcher.Changed -= OnFileSystemEvent;
                _watcher.Created -= OnFileSystemEvent;
                _watcher.Renamed -= OnFileSystemEvent;
                _watcher.Dispose();
                _watcher = null;
            }
        }

        public void Dispose()
        {
            Stop();
        }
    }
}
