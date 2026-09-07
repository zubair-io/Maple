// The WinUI-free, cldapi-free half of the Cloud Files FETCH_DATA callback
// (#2589): the rules for which hydration requests the sync root can serve
// and the aligned-chunk streaming loop that turns a response body into
// TRANSFER_DATA deliveries. Split out of CloudFilesSyncRoot.cs so the
// ranged-read contract is pinned by Maple.WinUI.Tests without a live
// sync root (#1325 cutover audit).

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.CloudFiles
{
    internal static class CloudFilesHydration
    {
        /// <summary>Whether a FETCH_DATA request can be served. The FULL
        /// hydration policy makes every request start at 0 and cover the
        /// whole file, and the sequential body stream depends on that: the
        /// original-bytes route delivers the file from its first byte (it
        /// honours no Range header), so a non-zero required offset — a
        /// future policy change, or a restarted partial hydration — must
        /// fail cleanly rather than deliver bytes at the wrong offsets and
        /// corrupt the read.</summary>
        internal static bool IsSupportedRequest(long requiredFileOffset) =>
            requiredFileOffset == 0;

        /// <summary>Streams <paramref name="body"/> from offset 0 into
        /// <paramref name="deliver"/>(buffer, length, fileOffset) calls.
        /// Every delivered chunk is a multiple of <paramref name="alignment"/>
        /// except the last, which ends at EOF — the only place the platform
        /// accepts a short tail. Returns the total bytes delivered.</summary>
        internal static async Task<long> StreamAlignedAsync(
            Stream body, int alignment, Action<byte[], int, long> deliver, CancellationToken ct)
        {
            var buffer = new byte[1 << 20];
            long delivered = 0;
            var filled = 0;
            while (true)
            {
                var read = await body.ReadAsync(
                    buffer.AsMemory(filled, buffer.Length - filled), ct).ConfigureAwait(false);
                if (read > 0)
                {
                    filled += read;
                    if (filled < buffer.Length)
                        continue;
                }

                // Flush the aligned prefix; at end of stream flush everything
                // (a short tail is legal only when it reaches EOF).
                var flush = read > 0 ? filled - filled % alignment : filled;
                if (flush > 0)
                {
                    deliver(buffer, flush, delivered);
                    delivered += flush;
                    Buffer.BlockCopy(buffer, flush, buffer, 0, filled - flush);
                    filled -= flush;
                }
                if (read <= 0)
                    return delivered;
            }
        }
    }
}
