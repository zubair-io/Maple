$ErrorActionPreference = 'Stop'
$parseTokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'qualify-winui.ps1'), [ref]$parseTokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
. "$PSScriptRoot/qualification-fixture.ps1"
$testRoot = Join-Path $env:TEMP ('maple-qualification-copy-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$source = Join-Path $testRoot 'fixture [one].dng'
$sidecar = [IO.Path]::ChangeExtension($source, '.xmp')
[IO.File]::WriteAllBytes($source, [byte[]](1, 4, 9, 16))
[IO.File]::WriteAllText($sidecar, '<xmp unknown="preserve">opening edits</xmp>')
$sourceHash = (Get-FileHash -LiteralPath $source).Hash
$sidecarHash = (Get-FileHash -LiteralPath $sidecar).Hash
$seed = Copy-QualificationFixture $source (Join-Path $testRoot 'seed')
$gpu = Copy-QualificationFixture $seed (Join-Path $testRoot 'gpu')
[IO.File]::WriteAllText([IO.Path]::ChangeExtension($gpu, '.xmp'), 'simulated autosave')
$cpu = Copy-QualificationFixture $seed (Join-Path $testRoot 'cpu')
foreach ($candidate in @($source, $seed, $gpu, $cpu)) {
    if ((Get-FileHash -LiteralPath $candidate).Hash -ne $sourceHash) { throw 'RAW bytes changed' }
}
foreach ($candidate in @($source, $seed, $cpu)) {
    if ((Get-FileHash -LiteralPath ([IO.Path]::ChangeExtension($candidate, '.xmp'))).Hash -ne $sidecarHash) {
        throw 'Autosave leaked into the source, reference or next run'
    }
}
$rejected = $false
try { Copy-QualificationFixture $source (Join-Path $testRoot 'cpu') | Out-Null }
catch { $rejected = $_.Exception.Message.Contains('already exists') }
if (!$rejected) { throw 'Existing qualification files were overwritten' }
$bare = Join-Path $testRoot 'no-sidecar.dng'
[IO.File]::WriteAllBytes($bare, [byte[]](2, 3))
$copy = Copy-QualificationFixture $bare (Join-Path $testRoot 'bare')
if (Test-Path -LiteralPath ([IO.Path]::ChangeExtension($copy, '.xmp'))) { throw 'Absent sidecar was fabricated' }
Write-Output "PASS: independent RAW/sidecar copies, unknown bytes, absent sidecar and overwrite rejection ($testRoot)"
