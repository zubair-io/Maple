// RawFfiLayoutTests — the C# ↔ Rust struct-layout gate (#3221).
//
// Every `[StructLayout(Sequential)]` struct under Native\ is a hand-typed
// mirror of a `#[repr(C)]` struct in raw-ffi, and until this gate nothing
// checked that the two agreed: `MapleGpuLiveParams` shipped for a month
// without #2683's film-look tail (Rust read those fields past the end of the
// C# allocation), and `MapleSceneLinearBufferF32` was missing #2231's two
// trailing `u32`s. raw-ffi's `maple_abi_layout` (abi_layout.rs) reports, for
// a struct name, `size=N;field=offset;…` computed with `core::mem::offset_of!`
// from the real Rust definition; this suite loads the `raw_ffi.dll` the CI
// job just built and asserts `Marshal.SizeOf` / `Marshal.OffsetOf` of each
// mirror against it — every field, by name, in declaration order.
//
// The DLL is located through the `MAPLE_RAW_FFI_DLL` environment variable
// (.github/workflows/windows.yml sets it). Without it — a developer running
// `dotnet test` on a machine with no Rust build — the tests skip-pass with a
// message, the same convention as every fixture-gated Rust harness in this
// repo. With it set, a missing or unloadable DLL is a FAILURE, not a skip,
// so CI cannot silently lose the gate.

using System.Reflection;
using System.Runtime.InteropServices;
using Maple.WinUI.Native;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests
{
    public class RawFfiLayoutTests
    {
        private const string DllEnvVar = "MAPLE_RAW_FFI_DLL";
        private const string DllImportName = "maple-raw-ffi-under-test";

        private readonly ITestOutputHelper _output;

        public RawFfiLayoutTests(ITestOutputHelper output)
        {
            _output = output;
        }

        static RawFfiLayoutTests()
        {
            // Resolve our private import name to whatever the environment
            // points at, so the test never depends on `raw_ffi.dll` sitting
            // on the probing path (it does not, for a plain `dotnet test`).
            NativeLibrary.SetDllImportResolver(typeof(RawFfiLayoutTests).Assembly, (name, _, _) =>
            {
                if (name != DllImportName && name != "raw_ffi.dll") return IntPtr.Zero;
                var dll = Environment.GetEnvironmentVariable(DllEnvVar);
                return string.IsNullOrEmpty(dll) ? IntPtr.Zero : NativeLibrary.Load(dll);
            });
        }

        [DllImport(DllImportName, CallingConvention = CallingConvention.Cdecl)]
        private static extern int maple_abi_layout(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string structName,
            byte[] outBuf,
            nuint outCap,
            out nuint outLen);

        /// <summary>Every C# mirror of a raw-ffi `#[repr(C)]` struct.</summary>
        public static IEnumerable<object[]> Mirrors => new[]
        {
            new object[] { typeof(MapleAdjustmentParams) },
            new object[] { typeof(MapleToneCurves) },
            new object[] { typeof(MapleSceneLinearBufferF32) },
            new object[] { typeof(MapleAutoAdjustments) },
            new object[] { typeof(MapleGpuLiveParams) },
            new object[] { typeof(MapleGpuLiveSession) },
        };

        [Theory]
        [MemberData(nameof(Mirrors))]
        public void MirrorMatchesRustLayoutFieldForField(Type mirror)
        {
            var dll = Environment.GetEnvironmentVariable(DllEnvVar);
            if (string.IsNullOrEmpty(dll))
            {
                _output.WriteLine($"SKIP-PASS: {DllEnvVar} not set; no raw_ffi.dll to compare {mirror.Name} against.");
                return;
            }
            Assert.True(File.Exists(dll), $"{DllEnvVar} points at a missing file: {dll}");

            var (rustSize, rustFields) = RustLayout(mirror.Name);
            var csharpFields = mirror
                .GetFields(BindingFlags.Public | BindingFlags.Instance)
                .OrderBy(f => f.MetadataToken)
                .ToList();

            Assert.Equal(rustSize, (long)Marshal.SizeOf(mirror));
            // Same names in the same order: catches a field appended on one
            // side only, a reorder, and a rename — before any offset math.
            Assert.Equal(rustFields.Select(f => f.Name), csharpFields.Select(f => f.Name));
            foreach (var (name, offset) in rustFields)
            {
                Assert.True(
                    offset == (long)Marshal.OffsetOf(mirror, name),
                    $"{mirror.Name}.{name}: Rust offset {offset}, C# offset {(long)Marshal.OffsetOf(mirror, name)}");
            }
        }

        private (long Size, List<(string Name, long Offset)> Fields) RustLayout(string structName)
        {
            var buf = new byte[8192];
            var rc = maple_abi_layout(structName, buf, (nuint)buf.Length, out var len);
            Assert.True(rc == 0, $"maple_abi_layout(\"{structName}\") rc={rc} (1 = the DLL does not export this struct — built without --features gpu?)");
            var text = System.Text.Encoding.UTF8.GetString(buf, 0, (int)len);
            _output.WriteLine($"{structName}: {text}");

            var parts = text.Split(';');
            Assert.StartsWith("size=", parts[0]);
            var size = long.Parse(parts[0]["size=".Length..], System.Globalization.CultureInfo.InvariantCulture);
            var fields = parts
                .Skip(1)
                .Select(p =>
                {
                    var eq = p.IndexOf('=');
                    return (Name: p[..eq], Offset: long.Parse(p[(eq + 1)..], System.Globalization.CultureInfo.InvariantCulture));
                })
                .ToList();
            return (size, fields);
        }
    }
}
