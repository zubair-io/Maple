using System;
using System.Threading;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// The native-detail patch's dehaze maps (#3287), kept per decoded frame
    /// and haze key so pans and dehaze moves at 100% never hand the frame to
    /// Rust again. One entry: native detail works on one frame. The frame is
    /// held weakly, so the cache never keeps a released decode alive and a
    /// collected frame can only miss.
    /// </summary>
    public static class NativeDetailHazeCache
    {
        private sealed record Entry(WeakReference<DecodedImage> Frame, ulong Key, HazeMapHandle? Map);

        private static readonly object Gate = new();
        private static Entry? _entry;
        private static int _measurements;

        /// <summary>How many lookups measured; tests assert a hit measures nothing.</summary>
        public static int Measurements => Volatile.Read(ref _measurements);

        /// <summary>The cached maps for <paramref name="frame"/> under
        /// <paramref name="key"/>, if any, with a reference added for the
        /// caller, who releases it
        /// (<see cref="System.Runtime.InteropServices.SafeHandle.DangerousRelease"/>)
        /// when the render is done.</summary>
        public static bool TryRent(DecodedImage frame, ulong key, out HazeMapHandle? map)
        {
            lock (Gate)
            {
                var hit = _entry is { } entry && entry.Key == key
                    && entry.Frame.TryGetTarget(out var cached) && ReferenceEquals(cached, frame);
                map = hit ? AddRef(_entry!.Map) : null;
                return hit;
            }
        }

        /// <summary>Cache <paramref name="map"/>, measured outside the lock,
        /// in place of the previous entry (freed once its last user releases
        /// it), and rent it like <see cref="TryRent"/>.</summary>
        public static HazeMapHandle? StoreAndRent(DecodedImage frame, ulong key, HazeMapHandle? map)
        {
            lock (Gate)
            {
                Interlocked.Increment(ref _measurements);
                _entry?.Map?.Dispose();
                _entry = new Entry(new WeakReference<DecodedImage>(frame), key, map);
                return AddRef(map);
            }
        }

        private static HazeMapHandle? AddRef(HazeMapHandle? map)
        {
            var added = false;
            map?.DangerousAddRef(ref added);
            return map;
        }

        /// <summary>Free the cached maps (the native-detail source closed).</summary>
        public static void Clear()
        {
            lock (Gate)
            {
                _entry?.Map?.Dispose();
                _entry = null;
            }
        }
    }
}
