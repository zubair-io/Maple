// RawJpegStackCloudTests — the two server calls behind a folded Maple Cloud
// tile (#5050, #5848), pinned against a fake HttpMessageHandler: the display
// config that decides whether Browse folds, and the one-request pair trash.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegStackCloudTests : IDisposable
    {
        private readonly string _cacheDir = Path.Combine(
            Path.GetTempPath(), "maple-stack-cloud-tests-" + Guid.NewGuid().ToString("N"));

        public void Dispose()
        {
            try { Directory.Delete(_cacheDir, recursive: true); }
            catch (IOException) { }
        }

        private sealed class FakeHandler : HttpMessageHandler
        {
            private readonly HttpStatusCode _status;
            private readonly string? _body;

            public FakeHandler(HttpStatusCode status, string? body = null)
            {
                _status = status;
                _body = body;
            }

            public List<HttpRequestMessage> Requests { get; } = new();

            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Requests.Add(request);
                var response = new HttpResponseMessage(_status);
                if (_body != null)
                    response.Content = new StringContent(_body, Encoding.UTF8, "application/json");
                return Task.FromResult(response);
            }
        }

        private CloudClient Client(HttpMessageHandler handler) =>
            new("https://maple.example.test", handler, _cacheDir);

        [Theory]
        [InlineData("{\"stack_raw_jpeg\":true,\"stack_pair_ops_supported\":true}", true)]
        [InlineData("{\"show_hidden_images\":false,\"stack_pair_ops_supported\":true}", true)]
        [InlineData("{\"stack_raw_jpeg\":false,\"stack_pair_ops_supported\":true}", false)]
        [InlineData("{\"stack_raw_jpeg\":true}", false)]
        [InlineData("{\"stack_raw_jpeg\":true,\"stack_pair_ops_supported\":false}", false)]
        [InlineData("{}", false)]
        public async Task BrowseFolds_OnlyWhenThePreferenceIsOnAndTheServerTrashesPairs(string body, bool folds)
        {
            var handler = new FakeHandler(HttpStatusCode.OK, body);
            using var client = Client(handler);

            var config = await client.GetDisplayConfigAsync(CancellationToken.None);

            Assert.Equal(folds, config!.FoldsRawJpegStacks);
            Assert.Equal("/api/display/config", handler.Requests.Single().RequestUri!.PathAndQuery);
        }

        [Fact]
        public async Task AServerWithoutTheDisplayConfig_AnswersNothing_SoBrowseStaysUnfolded()
        {
            using var client = Client(new FakeHandler(HttpStatusCode.NotFound));

            Assert.Null(await client.GetDisplayConfigAsync(CancellationToken.None));
        }

        [Fact]
        public async Task ThePairIsTrashedInOneRequest_NamingTheJpegAsTheCompanion()
        {
            var handler = new FakeHandler(HttpStatusCode.NoContent);
            using var client = Client(handler);

            var result = await client.TrashStackAsync(
                "65a000000000000000000001", "65a000000000000000000002", CancellationToken.None);

            Assert.Equal(CloudStackTrashResult.Trashed, result);
            var request = handler.Requests.Single();
            Assert.Equal(HttpMethod.Delete, request.Method);
            Assert.Equal(
                "/api/assets/65a000000000000000000001?intent=trash&companion=65a000000000000000000002",
                request.RequestUri!.PathAndQuery);
        }

        [Theory]
        [InlineData(HttpStatusCode.NotFound, CloudStackTrashResult.Missing)]
        [InlineData(HttpStatusCode.Conflict, CloudStackTrashResult.AlreadyTrashed)]
        [InlineData(HttpStatusCode.BadRequest, CloudStackTrashResult.Refused)]
        [InlineData(HttpStatusCode.InternalServerError, CloudStackTrashResult.Refused)]
        public async Task ARefusedPairTrash_IsNeverReportedAsTrashed(HttpStatusCode status, CloudStackTrashResult expected)
        {
            using var client = Client(new FakeHandler(status, "{\"error\":\"refused\",\"state\":\"trashed\"}"));

            Assert.Equal(expected, await client.TrashStackAsync("raw", "jpeg", CancellationToken.None));
        }
    }
}
