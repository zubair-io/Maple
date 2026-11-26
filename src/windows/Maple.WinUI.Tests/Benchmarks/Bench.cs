using System.Globalization;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

[CollectionDefinition(Bench.CollectionName)]
public sealed class BenchmarkCollection : ICollectionFixture<SyntheticPhotoFixture>
{
}

public sealed class SyntheticPhotoFixture
{
    public const int Width = 6000;
    public const int Height = 4000;
    public const int LibraryWidth = 1600;
    public const int LibraryHeight = 1250;

    public string Path { get; } = Bench.OutDirectory == null
        ? string.Empty
        : SyntheticDng.Write(System.IO.Path.Combine(Bench.FixtureDirectory, "photo-24mp.dng"), Width, Height);

    public string LibraryPath { get; } = Bench.OutDirectory == null
        ? string.Empty
        : SyntheticDng.Write(System.IO.Path.Combine(Bench.FixtureDirectory, "photo-2mp.dng"), LibraryWidth, LibraryHeight);
}

internal static class Bench
{
    internal const string CollectionName = "Benchmarks";
    private const string OutVariable = "MAPLE_BENCH_OUT";
    private static readonly object FileGate = new();

    internal static string? OutDirectory =>
        Environment.GetEnvironmentVariable(OutVariable) is { Length: > 0 } value ? value : null;

    internal static string FixtureDirectory =>
        System.IO.Path.Combine(System.IO.Path.GetTempPath(), "maple-bench-fixtures");

    internal static bool NativeAvailable =>
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL"));

    internal static void Line(ITestOutputHelper output, string text)
    {
        var line = $"[bench] {text}";
        output.WriteLine(line);
        if (OutDirectory is not { } directory) return;
        lock (FileGate)
            File.AppendAllText(System.IO.Path.Combine(directory, "bench-native.txt"), line + Environment.NewLine);
    }

    internal static void Stats(ITestOutputHelper output, string name, IReadOnlyList<double> samples, string unit = "ms")
    {
        var sorted = samples.Order().ToArray();
        var middle = sorted.Length / 2;
        var median = sorted.Length % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
        Line(output, $"{name}: min {Format(sorted[0])} {unit}, median {Format(median)} {unit}, max {Format(sorted[^1])} {unit} (n={sorted.Length})");
    }

    internal static double Measure(Action work)
    {
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        work();
        return System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds;
    }

    internal static async Task<double> MeasureAsync(Func<Task> work)
    {
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        await work();
        return System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds;
    }

    internal static string Format(double value) => value.ToString("0.00", CultureInfo.InvariantCulture);
}

internal sealed class BenchmarkFactAttribute : FactAttribute
{
    public BenchmarkFactAttribute(bool native = false)
    {
        Skip = Bench.OutDirectory == null ? "Set MAPLE_BENCH_OUT to a directory to run the timing benchmarks."
            : native && !Bench.NativeAvailable ? "Set MAPLE_RAW_FFI_DLL to time the native calls."
            : null;
    }
}
