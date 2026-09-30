using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services.Transfer;

public static class TransferBaseline
{
    public static Task<WhiteBalanceBaseline> ReadAsync(string path, CancellationToken cancellation) => Task.Run(() =>
    {
        cancellation.ThrowIfCancellationRequested();
        var baseline = Read(path);
        cancellation.ThrowIfCancellationRequested();
        return baseline;
    }, cancellation);

    private static unsafe WhiteBalanceBaseline Read(string path)
    {
        float* pair = stackalloc float[2];
        var result = RawFfi.maple_as_shot_white_balance_file(path, pair);
        if (result != 0) throw new IOException(RawFfi.LastError() ?? "Cannot read camera As Shot white balance.");
        var baseline = new WhiteBalanceBaseline(pair[0], pair[1]);
        if (!baseline.IsValid) throw new IOException("The camera white balance is invalid.");
        return baseline.Snap();
    }
}
