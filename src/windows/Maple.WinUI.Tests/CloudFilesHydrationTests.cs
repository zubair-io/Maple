// CloudFilesHydrationTests — the ranged-read contract of the Cloud Files
// FETCH_DATA callback (Services/CloudFiles/CloudFilesHydration.cs, #2589):
// hydration serves whole-file requests from offset 0 only, and delivers the
// body in 4096-aligned TRANSFER_DATA chunks with a short tail permitted only
// at EOF. Pinned here because the sync root itself is cldapi P/Invoke end to
// end and cannot run outside a registered Windows sync root.

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.CloudFiles;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class CloudFilesHydrationTests
    {
        private const int Alignment = 4096;

        /// <summary>A stream that hands out at most <paramref name="maxRead"/>
        /// bytes per read — the shape a chunked HTTP body arrives in, where
        /// reads never line up with the alignment.</summary>
        private sealed class DribbleStream : Stream
        {
            private readonly byte[] _data;
            private readonly int _maxRead;
            private int _pos;
            public DribbleStream(byte[] data, int maxRead) { _data = data; _maxRead = maxRead; }
            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => _data.Length;
            public override long Position { get => _pos; set => throw new NotSupportedException(); }
            public override void Flush() { }
            public override int Read(byte[] buffer, int offset, int count)
            {
                var n = Math.Min(Math.Min(count, _maxRead), _data.Length - _pos);
                Buffer.BlockCopy(_data, _pos, buffer, offset, n);
                _pos += n;
                return n;
            }
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

        private static async Task<(List<(int length, long offset)> chunks, byte[] reassembled, long delivered)> Run(
            byte[] body, int maxRead)
        {
            var chunks = new List<(int, long)>();
            using var sink = new MemoryStream();
            var delivered = await CloudFilesHydration.StreamAlignedAsync(
                new DribbleStream(body, maxRead), Alignment,
                (buffer, length, offset) =>
                {
                    chunks.Add((length, offset));
                    Assert.Equal(sink.Length, offset);   // contiguous, in order
                    sink.Write(buffer, 0, length);
                },
                CancellationToken.None);
            return (chunks, sink.ToArray(), delivered);
        }

        [Fact]
        public void OnlyOffsetZeroIsSupported()
        {
            // The FULL hydration policy asks for the whole file from 0; the
            // original-bytes route honours no Range header, so any other
            // offset must be refused rather than served at the wrong place.
            Assert.True(CloudFilesHydration.IsSupportedRequest(0));
            Assert.False(CloudFilesHydration.IsSupportedRequest(1));
            Assert.False(CloudFilesHydration.IsSupportedRequest(Alignment));
            Assert.False(CloudFilesHydration.IsSupportedRequest(long.MaxValue));
        }

        [Fact]
        public async Task DeliversWholeBodyByteIdentical_FromOffsetZero()
        {
            var body = new byte[(1 << 20) * 2 + 12_345];   // > one buffer, unaligned tail
            new Random(7).NextBytes(body);

            var (chunks, reassembled, delivered) = await Run(body, maxRead: 7_001);

            Assert.Equal(body.Length, delivered);
            Assert.Equal(body, reassembled);
            Assert.Equal(0, chunks[0].offset);
        }

        [Fact]
        public async Task EveryChunkExceptTheLastIsAligned_TailOnlyAtEof()
        {
            var body = new byte[(1 << 20) + 5_000];
            new Random(8).NextBytes(body);

            var (chunks, _, _) = await Run(body, maxRead: 999);

            Assert.True(chunks.Count >= 2);
            for (var i = 0; i < chunks.Count - 1; i++)
            {
                Assert.Equal(0, chunks[i].length % Alignment);
                Assert.Equal(0, chunks[i].offset % Alignment);
            }
            var last = chunks[^1];
            Assert.Equal(body.Length, last.offset + last.length);
        }

        [Fact]
        public async Task AlignedBody_HasNoShortTail()
        {
            var body = new byte[Alignment * 300];
            new Random(9).NextBytes(body);

            var (chunks, reassembled, _) = await Run(body, maxRead: 4_097);

            Assert.All(chunks, c => Assert.Equal(0, c.length % Alignment));
            Assert.Equal(body, reassembled);
        }

        [Fact]
        public async Task EmptyBody_DeliversNothing()
        {
            var (chunks, _, delivered) = await Run(Array.Empty<byte>(), maxRead: 100);

            Assert.Empty(chunks);
            Assert.Equal(0, delivered);
        }

        [Fact]
        public async Task Cancellation_StopsBeforeDelivering()
        {
            using var cts = new CancellationTokenSource();
            cts.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                CloudFilesHydration.StreamAlignedAsync(
                    new DribbleStream(new byte[Alignment * 4], 512), Alignment,
                    (_, _, _) => Assert.Fail("nothing may be delivered after cancellation"),
                    cts.Token));
        }
    }
}
