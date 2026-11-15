using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.CloudFiles;
using Xunit;

namespace Maple.WinUI.Tests
{
    /// <summary>
    /// Opt-in end-to-end CFAPI population probe. Unlike the lower-level
    /// placeholder test, this starts Maple's production sync-root callback
    /// table and asks a separate process to enumerate a disposable NTFS root.
    /// </summary>
    public sealed class CloudFilesConnectedPopulationProbeTests
    {
        private const string ProbeSwitch = "MAPLE_CLOUD_FILES_CONNECTED_POPULATION_PROBE";

        [Fact]
        public async Task ProductionCallbackTransfersPagedPlaceholdersDuringExternalEnumeration()
        {
            if (!OperatingSystem.IsWindows() || Environment.GetEnvironmentVariable(ProbeSwitch) != "1")
                return;

            var root = Path.Combine(Path.GetTempPath(), $"Maple-CFAPI-5855-connected-{Guid.NewGuid():N}");
            Assert.Equal("NTFS", new DriveInfo(Path.GetPathRoot(root)!).DriveFormat);
            var cache = Path.Combine(Path.GetTempPath(), $"Maple-CFAPI-5855-cache-{Guid.NewGuid():N}");
            var handler = new PopulationHandler();
            using var client = new CloudClient("http://maple-cfapi-population.invalid", handler, cache);
            var login = await client.DevLoginAsync(CancellationToken.None);
            Assert.True(login.Ok, login.Message);

            using var provider = new CloudFilesSyncRoot(() => client, root);
            try
            {
                Assert.Null(provider.Start());
                Assert.True(provider.IsRunning);

                var rootRead = EnumerateFromExternalProcess(root);
                Assert.Equal(0, rootRead.ExitCode);
                Assert.Contains("Probe Library", rootRead.Entries);

                var library = Path.Combine(root, "Probe Library");
                var listingRead = EnumerateFromExternalProcess(library);
                Assert.Equal(0, listingRead.ExitCode);
                Assert.Contains("IMG.JPG", listingRead.Entries, StringComparer.OrdinalIgnoreCase);
                Assert.Contains("SECOND.JPG", listingRead.Entries, StringComparer.OrdinalIgnoreCase);

                Assert.Equal(new string?[] { null, "next" }, handler.PageCursors.Take(2).ToArray());
            }
            finally
            {
                provider.Stop(unregister: true);
                if (Directory.Exists(root)
                    && Path.GetFileName(root).StartsWith("Maple-CFAPI-5855-connected-", StringComparison.Ordinal))
                    Directory.Delete(root, recursive: true);
                if (Directory.Exists(cache)
                    && Path.GetFileName(cache).StartsWith("Maple-CFAPI-5855-cache-", StringComparison.Ordinal))
                    Directory.Delete(cache, recursive: true);
            }
        }

        private static (int ExitCode, string[] Entries) EnumerateFromExternalProcess(string directory)
        {
            var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            var start = new ProcessStartInfo(powershell)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add("-NoProfile");
            start.ArgumentList.Add("-NonInteractive");
            start.ArgumentList.Add("-STA");
            start.ArgumentList.Add("-Command");
            start.ArgumentList.Add("$ErrorActionPreference='Stop'; [IO.Directory]::GetFileSystemEntries($env:MAPLE_CFAPI_ENUM_ROOT) | ForEach-Object { [IO.Path]::GetFileName($_) }");
            start.Environment["MAPLE_CFAPI_ENUM_ROOT"] = directory;

            using var process = Process.Start(start)!;
            if (!process.WaitForExit(30_000))
            {
                process.Kill(entireProcessTree: true);
                throw new TimeoutException("External Cloud Files enumeration did not return within 30 seconds.");
            }
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(string.IsNullOrWhiteSpace(stderr), stderr);
            return (process.ExitCode, stdout.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
        }

        private sealed class PopulationHandler : HttpMessageHandler
        {
            public ConcurrentQueue<string?> PageCursors { get; } = new();

            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request, CancellationToken cancellationToken)
            {
                var path = request.RequestUri!.PathAndQuery;
                if (request.Method == HttpMethod.Post && path == "/api/auth/dev-login")
                    return Json(HttpStatusCode.OK, """{"access_token":"probe-token","refresh_token":"probe-refresh"}""");

                if (request.Method == HttpMethod.Get && path == "/api/folders")
                    return Json(HttpStatusCode.OK,
                        """[{"id":"0123456789abcdef01234567","slug":"probe","label":"Probe Library","path":"/probe","file_count":2}]""");

                if (request.Method == HttpMethod.Get && path.StartsWith("/api/folder/probe?", StringComparison.Ordinal))
                {
                    var cursor = request.RequestUri.Query.Contains("cursor=", StringComparison.Ordinal)
                        ? Uri.UnescapeDataString(request.RequestUri.Query.Split("cursor=", 2)[1])
                        : null;
                    PageCursors.Enqueue(cursor);
                    return cursor == null
                        ? Json(HttpStatusCode.OK,
                            """{"files":[{"name":"IMG.JPG","address":"probe:IMG.JPG","path":"/probe/IMG.JPG","size":1,"mtime":"2026-01-01T00:00:00Z"}],"next_cursor":"next"}""")
                        : cursor == "next"
                            ? Json(HttpStatusCode.OK,
                                """{"files":[{"name":"SECOND.JPG","address":"probe:SECOND.JPG","path":"/probe/SECOND.JPG","size":1,"mtime":"2026-01-01T00:00:00Z"}],"next_cursor":null}""")
                            : Json(HttpStatusCode.BadRequest, "{}");
                }

                return Json(HttpStatusCode.NotFound, "{}");
            }

            private static Task<HttpResponseMessage> Json(HttpStatusCode status, string body) =>
                Task.FromResult(new HttpResponseMessage(status)
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json"),
                });
        }
    }
}
