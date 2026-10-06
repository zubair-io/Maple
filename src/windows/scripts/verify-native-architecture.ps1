param(
    [Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string]$Architecture,
    [Parameter(Mandatory)][string[]]$Paths
)

$ErrorActionPreference = 'Stop'
$expected = if ($Architecture -eq 'arm64') { 0xAA64 } else { 0x8664 }
foreach ($path in $Paths) {
    $stream = [IO.File]::OpenRead((Resolve-Path $path).Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "$path is not a PE binary" }
        $stream.Position = 0x3C
        $offset = $reader.ReadInt32()
        if ($offset -lt 0 -or $offset -gt $stream.Length - 6) { throw "$path has an invalid PE offset" }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x4550) { throw "$path has an invalid PE signature" }
        $machine = $reader.ReadUInt16()
        if ($machine -ne $expected) {
            throw ("{0}: expected {1}, got machine 0x{2:X4}" -f $path, $Architecture, $machine)
        }
        Write-Output "$path verified as $Architecture"
    } finally {
        $reader.Dispose()
    }
}
