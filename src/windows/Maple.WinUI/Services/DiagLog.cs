using System;
using System.IO;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services
{
    /// <summary>Append-only diagnostics log at %LOCALAPPDATA%\Maple\maple.log —
    /// the unpackaged-app stand-in for a real trace session, used by the render
    /// paths to record GPU fallback reasons visible outside a debugger.</summary>
    public static class DiagLog
    {
        private static readonly DiagnosticLogQueue Writer = new(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Maple", "maple.log"));

        static DiagLog()
        {
            // Best-effort diagnostics must not keep shutdown waiting on storage.
            AppDomain.CurrentDomain.ProcessExit += (_, _) => Writer.Shutdown(TimeSpan.FromMilliseconds(250));
        }

        public static void Write(string message) =>
            Writer.Write($"{DateTime.Now:HH:mm:ss.fff} {message}");
    }

    /// <summary>One background disk writer; callers never perform file I/O.
    /// Retain up to 256 queued records, dropping new records under pressure.
    /// Report dropped records when writing resumes. Shutdown drains within its
    /// deadline; records remaining on stalled storage are best-effort.</summary>
    internal sealed class DiagnosticLogQueue
    {
        private readonly BlockingCollection<string> _messages = new(256);
        private readonly Action<string> _append;
        private readonly Task _worker;
        private long _dropped;

        internal DiagnosticLogQueue(string path) : this(message =>
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.AppendAllText(path, message + Environment.NewLine);
        }) { }

        internal DiagnosticLogQueue(Action<string> append)
        {
            _append = append;
            // A stalled file must not consume a shared render/decode pool worker.
            _worker = Task.Factory.StartNew(Consume, CancellationToken.None,
                TaskCreationOptions.LongRunning, TaskScheduler.Default);
        }

        internal long DroppedCount => Interlocked.Read(ref _dropped);

        internal void Write(string message)
        {
            try
            {
                if (!_messages.TryAdd(message)) Interlocked.Increment(ref _dropped);
            }
            catch (InvalidOperationException) { } // Process exit completed the queue.
        }

        internal bool Shutdown(TimeSpan timeout)
        {
            _messages.CompleteAdding();
            return _worker.Wait(timeout);
        }

        private void Consume()
        {
            long reportedDrops = 0;
            foreach (var message in _messages.GetConsumingEnumerable())
            {
                var drops = DroppedCount;
                if (drops != reportedDrops)
                {
                    Append($"[diagnostics] dropped {drops - reportedDrops} records while the queue was full");
                    reportedDrops = drops;
                }
                Append(message);
            }
        }

        private void Append(string message)
        {
            try { _append(message); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
