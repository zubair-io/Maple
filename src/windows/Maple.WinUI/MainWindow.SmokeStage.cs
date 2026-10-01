using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private static void RecordSmokeStage(string output, string stage)
    {
        using var process = Process.GetCurrentProcess();
        File.AppendAllText(Path.Combine(output, "stages.jsonl"), JsonSerializer.Serialize(new
        {
            stage, time = DateTimeOffset.UtcNow, threads = process.Threads.Count,
            workingSetBytes = process.WorkingSet64,
        }) + Environment.NewLine);
    }
}
