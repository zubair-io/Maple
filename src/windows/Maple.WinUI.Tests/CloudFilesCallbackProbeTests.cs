using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.CloudFiles;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

/// <summary>Opt-in CFAPI probe on a disposable NTFS root; the default suite skips it.</summary>
public sealed class CloudFilesCallbackProbeTests(ITestOutputHelper output)
{
    [Fact]
    public void NotifyCallbackTypesMatchCfapiEnum()
    {
        Assert.Equal(9, CfApi.CF_CALLBACK_TYPE_NOTIFY_DELETE);
        Assert.Equal(11, CfApi.CF_CALLBACK_TYPE_NOTIFY_RENAME);
    }

    [CloudFilesProbeFact]
    public void ExternalDeleteReachesAckDeleteAndLocalBackend()
    {
        using var fixture = new ProbeFixture();
        var item = fixture.Materialize("delete.dng");

        var result = ExternalFileOperation("delete", item);
        output.WriteLine($"External delete exit={result}");
        output.WriteLine("Connected callback table: " + string.Join(",", fixture.CallbackTypes));
        output.WriteLine("Callback entries: " + string.Join(",", fixture.CallbackEntries));
        output.WriteLine("ACKs: " + string.Join(",", fixture.Acks.Select(ack => $"type={ack.Type},status=0x{ack.Status:X8},hr=0x{ack.HResult:X8}")));
        output.WriteLine("Backend requests: " + string.Join(",", fixture.Backend.Requests.Select(request => request.Method + " " + request.PathAndQuery)));
        Assert.Contains(CfApi.CF_CALLBACK_TYPE_NOTIFY_DELETE, fixture.CallbackEntries);
        Assert.Contains(fixture.Acks, ack => ack.Type == CfApi.CF_OPERATION_TYPE_ACK_DELETE && ack.Status == 0 && ack.HResult == 0);
        Assert.Contains(fixture.Backend.Requests, request =>
            request.Method == "DELETE" && request.PathAndQuery == "/api/assets/asset-delete?intent=trash");
        Assert.False(File.Exists(item));
    }

    [CloudFilesProbeFact]
    public void OpeningPlaceholderReachesFetchData()
    {
        using var fixture = new ProbeFixture();
        var item = fixture.Materialize("delete.dng");

        try { _ = File.ReadAllBytes(item); }
        catch (IOException) { /* the local fake backend intentionally has no image body */ }

        output.WriteLine("Callback entries after open: " + string.Join(",", fixture.CallbackEntries));
        Assert.Contains(CfApi.CF_CALLBACK_TYPE_FETCH_DATA, fixture.CallbackEntries);
    }

    [CloudFilesProbeFact]
    public void ExternalRenameReachesDeniedAckAndLeavesPlaceholderInPlace()
    {
        using var fixture = new ProbeFixture();
        var item = fixture.Materialize("rename.dng");
        var target = Path.Combine(Path.GetDirectoryName(item)!, "renamed.dng");

        var result = ExternalFileOperation("rename", item, target);
        output.WriteLine($"External rename exit={result}");
        output.WriteLine("Callback entries: " + string.Join(",", fixture.CallbackEntries));
        output.WriteLine("ACKs: " + string.Join(",", fixture.Acks.Select(ack => $"type={ack.Type},status=0x{ack.Status:X8},hr=0x{ack.HResult:X8}")));
        Assert.Equal(1, result);
        Assert.Contains(CfApi.CF_CALLBACK_TYPE_NOTIFY_RENAME, fixture.CallbackEntries);
        Assert.Contains(fixture.Acks, ack => ack.Type == CfApi.CF_OPERATION_TYPE_ACK_RENAME
            && ack.Status == CfApi.STATUS_CLOUD_FILE_ACCESS_DENIED && ack.HResult == 0);
        Assert.True(File.Exists(item));
        Assert.False(File.Exists(target));
    }

    [CloudFilesProbeFact]
    public void AllowUndoShellDeleteUsesCloudDeleteCallback()
    {
        using var fixture = new ProbeFixture();
        var item = fixture.Materialize("allow-undo-probe.dng");

        var result = ExternalAllowUndoShellDelete(item);
        output.WriteLine($"Probe placeholder: {item}");
        output.WriteLine($"SHFileOperation exit={result.ExitCode}; diagnostics: {result.Diagnostics}");
        output.WriteLine("Callback entries: " + string.Join(",", fixture.CallbackEntries));
        output.WriteLine("ACKs: " + string.Join(",", fixture.Acks.Select(ack => $"type={ack.Type},status=0x{ack.Status:X8},hr=0x{ack.HResult:X8}")));
        output.WriteLine("Backend requests: " + string.Join(",", fixture.Backend.Requests.Select(request => request.Method + " " + request.PathAndQuery)));
        output.WriteLine($"Placeholder remains={File.Exists(item)}");
        Assert.Equal(0, result.ExitCode);
        Assert.Contains("flags=0x4654 allowUndo=True", result.Diagnostics);
        Assert.Contains("result=0 aborted=False", result.Diagnostics);
        Assert.Contains(CfApi.CF_CALLBACK_TYPE_NOTIFY_DELETE, fixture.CallbackEntries);
        Assert.DoesNotContain(CfApi.CF_CALLBACK_TYPE_NOTIFY_RENAME, fixture.CallbackEntries);
        Assert.Contains(fixture.Acks, ack => ack.Type == CfApi.CF_OPERATION_TYPE_ACK_DELETE && ack.Status == 0 && ack.HResult == 0);
        Assert.Contains(fixture.Backend.Requests, request => request.Method == "DELETE"
            && request.PathAndQuery == "/api/assets/asset-allow-undo?intent=trash");
        Assert.False(File.Exists(item));
    }

    private static int ExternalFileOperation(string operation, string from, string? to = null)
    {
        // The process that owns the CFAPI connection bypasses these notifications;
        // use a child process to model an external caller such as Explorer.
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        var command = operation == "delete"
            ? "[IO.File]::Delete($env:MAPLE_CFAPI_SOURCE); exit 0"
            : "try { [IO.File]::Move($env:MAPLE_CFAPI_SOURCE, $env:MAPLE_CFAPI_TARGET); exit 0 } catch { exit 1 }";
        var start = new ProcessStartInfo(powershell)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            Arguments = "-NoProfile -NonInteractive -Command " + command,
        };
        start.Environment["MAPLE_CFAPI_SOURCE"] = from;
        if (to != null) start.Environment["MAPLE_CFAPI_TARGET"] = to;
        using var process = Process.Start(start)!;
        process.WaitForExit();
        return process.ExitCode;
    }

    private static (int ExitCode, string Diagnostics) ExternalAllowUndoShellDelete(string path)
    {
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        var source = """
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct SHFILEOPSTRUCTW {
    public IntPtr hwnd;
    public uint wFunc;
    public IntPtr pFrom;
    public IntPtr pTo;
    public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    public IntPtr lpszProgressTitle;
}
public static class ShellRecycleProbe {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int SHFileOperationW(ref SHFILEOPSTRUCTW op);
}
'@
$path = $env:MAPLE_CFAPI_SOURCE
$buffer = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($path + [char]0)
try {
    $op = [SHFILEOPSTRUCTW]::new()
    $op.wFunc = 3
    $op.pFrom = $buffer
    $op.fFlags = 0x4654
    Write-Output "flags=0x$('{0:X4}' -f $op.fFlags) allowUndo=$([bool]($op.fFlags -band 0x40))"
    $result = [ShellRecycleProbe]::SHFileOperationW([ref]$op)
    Write-Output "result=$result aborted=$($op.fAnyOperationsAborted) lastError=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    if ($result -eq 0 -and -not $op.fAnyOperationsAborted) { exit 0 }
    exit 1
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
""";
        var script = Path.Combine(Path.GetTempPath(), "Maple-CFAPI-recycle-probe-" + Guid.NewGuid().ToString("N") + ".ps1");
        try
        {
            File.WriteAllText(script, source, Encoding.UTF8);
            var start = new ProcessStartInfo(powershell)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
            };
            start.ArgumentList.Add("-NoProfile");
            start.ArgumentList.Add("-NonInteractive");
            start.ArgumentList.Add("-STA");
            start.ArgumentList.Add("-ExecutionPolicy");
            start.ArgumentList.Add("Bypass");
            start.ArgumentList.Add("-File");
            start.ArgumentList.Add(script);
            start.Environment["MAPLE_CFAPI_SOURCE"] = path;
            using var process = Process.Start(start)!;
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            return (process.ExitCode, output.Trim());
        }
        finally { try { File.Delete(script); } catch { } }
    }

    private sealed class ProbeFixture : IDisposable
    {
        private const string FolderId = "0123456789abcdef01234567";
        private const string Slug = "cfapi-probe";
        private const string AccessToken = "local-cfapi-probe-token";
        private readonly string _root;
        private readonly string _cache;
        private readonly CloudClient _client;
        private readonly CloudFilesSyncRoot _provider;

        public ProbeBackend Backend { get; } = new();
        public ConcurrentQueue<(int Type, int Status, int HResult)> Acks { get; } = new();
        public ConcurrentQueue<int> CallbackEntries { get; } = new();
        public int[] CallbackTypes => _provider.CallbackTypesForTest!;

        public ProbeFixture()
        {
            var temp = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "Maple-CFAPI-probe-" + Guid.NewGuid().ToString("N")));
            Assert.True(new DriveInfo(Path.GetPathRoot(temp)!).DriveFormat.Equals("NTFS", StringComparison.OrdinalIgnoreCase),
                "CFAPI integration probe requires a temporary directory on NTFS.");
            _root = temp;
            _cache = Path.Combine(Path.GetTempPath(), "Maple-CFAPI-cache-" + Guid.NewGuid().ToString("N"));
            _client = new CloudClient("http://maple-cfapi-probe.invalid", Backend, _cache);
            _provider = new CloudFilesSyncRoot(() => _client, _root);
            _provider.AckResultForTest = (type, status, hr) => Acks.Enqueue((type, status, hr));
            _provider.NotifyEnteredForTest = type => CallbackEntries.Enqueue(type);
            try
            {
                var login = _client.DevLoginAsync(CancellationToken.None).GetAwaiter().GetResult();
                Assert.True(login.Ok, login.Message);
                var error = _provider.Start();
                Assert.Null(error);
                Assert.True(_provider.IsRunning, "CFAPI sync root connected successfully before issuing shell operations.");
                var registeredTypes = _provider.CallbackTypesForTest!;
                Assert.Contains(CfApi.CF_CALLBACK_TYPE_NOTIFY_DELETE, registeredTypes);
                Assert.Contains(CfApi.CF_CALLBACK_TYPE_NOTIFY_RENAME, registeredTypes);
                Assert.Equal(CfApi.CF_CALLBACK_TYPE_NONE, registeredTypes[^1]);
            }
            catch
            {
                try { _provider.Stop(unregister: true); } catch { }
                _client.Dispose();
                DeleteOwnedTempPath(_cache);
                DeleteOwnedTempPath(_root);
                throw;
            }
        }

        public string Materialize(string name)
        {
            CreatePlaceholder(_root, "Probe", Slug + ":", isDirectory: true);
            var library = Assert.Single(Directory.GetDirectories(_root));
            CreatePlaceholder(library, name, Slug + ":" + name, isDirectory: false);
            var expected = Path.Combine(library, name);
            Assert.True(File.Exists(expected), $"Failed to create test placeholder {name}.");
            using (var handle = CloudFilesPlaceholderProbe.Win32.OpenReparsePoint(expected))
            {
                var tag = CloudFilesPlaceholderProbe.Win32.ReadAttributeTag(handle, expected);
                var state = CfApi.CfGetPlaceholderStateFromAttributeTag(tag.Attributes, tag.ReparseTag);
                Assert.NotEqual(CfApi.CF_PLACEHOLDER_STATE_INVALID, state);
                Assert.NotEqual(0u, state & CfApi.CF_PLACEHOLDER_STATE_PLACEHOLDER);
            }
            return expected;
        }

        private static void CreatePlaceholder(string parent, string name, string identity, bool isDirectory)
        {
            var namePointer = Marshal.StringToHGlobalUni(name);
            var identityPointer = Marshal.StringToHGlobalUni(identity);
            try
            {
                var timestamp = DateTime.UtcNow.ToFileTimeUtc();
                var entry = new CfApi.CF_PLACEHOLDER_CREATE_INFO
                {
                    RelativeFileName = namePointer,
                    FileIdentity = identityPointer,
                    FileIdentityLength = (uint)Encoding.Unicode.GetByteCount(identity),
                    Flags = CfApi.CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC
                        | (isDirectory ? CfApi.CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION : 0),
                    FsMetadata = new CfApi.CF_FS_METADATA
                    {
                            FileSize = isDirectory ? 0 : 1,
                        BasicInfo = new CfApi.FILE_BASIC_INFO
                        {
                            CreationTime = timestamp,
                            LastAccessTime = timestamp,
                            LastWriteTime = timestamp,
                            ChangeTime = timestamp,
                            FileAttributes = isDirectory ? 0x10u : 0x80u,
                        },
                    },
                };
                var hr = CfApi.CfCreatePlaceholders(parent, new[] { entry }, 1, 0, out var processed);
                Assert.Equal(0, hr);
                Assert.Equal(1u, processed);
            }
            finally
            {
                Marshal.FreeHGlobal(namePointer);
                Marshal.FreeHGlobal(identityPointer);
            }
        }

        public void Dispose()
        {
            try { _provider.Stop(unregister: true); } catch { /* clean only this disposable fixture root */ }
            _client.Dispose();
            DeleteOwnedTempPath(_cache);
            DeleteOwnedTempPath(_root);
        }

        private static void DeleteOwnedTempPath(string path)
        {
            var tempRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var fullPath = Path.GetFullPath(path);
            if (!fullPath.StartsWith(tempRoot, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("CFAPI probe cleanup path escaped the temp directory.");
            try { if (Directory.Exists(fullPath)) Directory.Delete(fullPath, recursive: true); } catch { /* retain evidence on cleanup failure */ }
        }

        public sealed class ProbeBackend : HttpMessageHandler
        {
            public ConcurrentQueue<(string Method, string PathAndQuery)> Requests { get; } = new();

            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                var path = request.RequestUri!.PathAndQuery;
                Requests.Enqueue((request.Method.Method, path));
                var (status, body) = path switch
                {
                    "/api/auth/dev-login" => (HttpStatusCode.OK,
                        "{\"access_token\":\"" + AccessToken + "\",\"refresh_token\":\"local-refresh\"}"),
                    "/api/folders" => (HttpStatusCode.OK,
                        "[{\"id\":\"" + FolderId + "\",\"slug\":\"" + Slug + "\",\"path\":\"/probe\",\"label\":\"Probe\"}]"),
                    "/api/folder/cfapi-probe%3A?limit=500" => (HttpStatusCode.OK,
                        "{\"images\":["
                        + Entry("delete.dng", "asset-delete") + ","
                        + Entry("allow-undo-probe.dng", "asset-allow-undo") + ","
                        + Entry("rename.dng", "asset-rename") + ","
                        + "]}"),
                    var value when value.StartsWith("/api/assets/by-address?address=", StringComparison.Ordinal) =>
                        (HttpStatusCode.OK, Asset(value)),
                    var value when value.StartsWith("/api/assets/", StringComparison.Ordinal) && value.EndsWith("?intent=trash", StringComparison.Ordinal) =>
                        (HttpStatusCode.NoContent, string.Empty),
                    _ => (HttpStatusCode.NotFound, "{\"error\":\"unhandled local probe route\"}"),
                };
                return Task.FromResult(new HttpResponseMessage(status)
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json"),
                });
            }

            private static string Entry(string name, string assetId) =>
                "{\"name\":\"" + name + "\",\"address\":\"" + Slug + ":" + name
                + "\",\"path\":\"/probe/" + name + "\",\"size\":1,\"mtime\":\"2026-01-01T00:00:00Z\"}";

            private static string Asset(string pathAndQuery)
            {
                var address = Uri.UnescapeDataString(pathAndQuery.Split("address=", 2)[1]);
                var id = address.EndsWith("delete.dng", StringComparison.Ordinal) ? "asset-delete"
                    : address.EndsWith("allow-undo-probe.dng", StringComparison.Ordinal) ? "asset-allow-undo"
                    : "asset-rename";
                return "{\"id\":\"" + id + "\",\"folder_id\":\"" + FolderId + "\",\"filename\":\""
                    + JsonSerializer.Serialize(address[(Slug.Length + 1)..]).Trim('"') + "\"}";
            }
        }
    }
}

public sealed class CloudFilesProbeFactAttribute : FactAttribute
{
    public CloudFilesProbeFactAttribute()
    {
        if (!OperatingSystem.IsWindows())
            Skip = "CFAPI callback probe requires Windows.";
        else if (Environment.GetEnvironmentVariable("MAPLE_RUN_CLOUDFILES_CFAPI_INTEGRATION") != "1")
            Skip = "Set MAPLE_RUN_CLOUDFILES_CFAPI_INTEGRATION=1 to register a disposable NTFS sync root.";
    }
}
