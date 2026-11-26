# Evidence only: records timings of the built Windows app and its native calls.
# No number is compared with a threshold; the script fails only when a stage
# cannot run or measure (the workflow step allows that failure).
param(
    [Parameter(Mandatory)][string]$AppPath,
    [Parameter(Mandatory)][string]$OutDirectory
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot/../../..").Path
$app = (Resolve-Path $AppPath).Path
New-Item -ItemType Directory -Force $OutDirectory | Out-Null
$OutDirectory = (Resolve-Path $OutDirectory).Path
$fixtures = Join-Path ([IO.Path]::GetTempPath()) 'maple-bench-fixtures'
New-Item -ItemType Directory -Force $fixtures | Out-Null
$report = Join-Path $OutDirectory 'windows-timings.txt'
$nativeReport = Join-Path $OutDirectory 'bench-native.txt'
$inCi = $env:GITHUB_ACTIONS -eq 'true'
$bareLaunches = 5
$qualifyRuns = 5
$gridItems = 2000
$libraryPhotos = 300
$coldLaunches = 3
$warmLaunches = 5
$cloudFilesLaunches = 3
$failures = @()
Remove-Item $report, $nativeReport -ErrorAction SilentlyContinue

$running = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($app)) -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $app })
if ($running.Count -gt 0) {
    throw "Close the already-running build before timing it: $app (PID $($running.Id -join ', '))"
}

function Add-Line([string]$Text) {
    Write-Host $Text
    Add-Content -Path $report -Value $Text
}

function Get-Stats([double[]]$Values, [string]$Unit = 'ms') {
    $sorted = @($Values | Sort-Object)
    $middle = [int][math]::Floor($sorted.Count / 2)
    $median = if ($sorted.Count % 2 -eq 1) { $sorted[$middle] } else { ($sorted[$middle - 1] + $sorted[$middle]) / 2 }
    $format = { param($v) ([double]$v).ToString('0.00', [Globalization.CultureInfo]::InvariantCulture) }
    "min $(& $format $sorted[0]) $Unit, median $(& $format $median) $Unit, max $(& $format $sorted[-1]) $Unit (n=$($sorted.Count))"
}

function Invoke-Stage([string]$Name, [scriptblock]$Body) {
    Add-Line "== $Name =="
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try { & $Body }
    catch {
        $script:failures += "${Name}: $_"
        Add-Line "[timing] STAGE FAILED: ${Name}: $_"
        Write-Host "::warning::Windows timing stage failed: ${Name}: $_"
    }
    Add-Line "== $Name took $([math]::Round($clock.Elapsed.TotalSeconds)) s =="
}

function Start-App([string[]]$Arguments, [hashtable]$Environment) {
    $start = [Diagnostics.ProcessStartInfo]::new($app)
    $start.UseShellExecute = $false
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    foreach ($name in @('MAPLE_QUALIFY_RAW', 'MAPLE_QUALIFY_OUT', 'MAPLE_FORCE_CPU', 'MAPLE_DUMP_FRAME', 'MAPLE_DUMP_GPU_FRAME')) {
        $start.Environment.Remove($name) | Out-Null
    }
    foreach ($key in $Environment.Keys) { $start.Environment[$key] = $Environment[$key] }
    $process = [Diagnostics.Process]::Start($start)
    try {
        if (-not $process.WaitForExit(300000)) {
            $process.Kill($true)
            throw "app did not exit within 300 s: $($Arguments -join ' ')"
        }
        if ($process.ExitCode -ne 0) { throw "app exited $($process.ExitCode): $($Arguments -join ' ')" }
    } finally { $process.Dispose() }
}

function Invoke-SmokeMode([string]$Mode, [string]$Source, [string]$Output) {
    New-Item -ItemType Directory -Force $Output | Out-Null
    Remove-Item (Join-Path $Output '*') -Recurse -Force -ErrorAction SilentlyContinue
    Start-App @('--lifecycle-smoke', $Source, $Output, $Mode) @{}
    $lifecycle = Get-Content (Join-Path $Output 'lifecycle.json') -Raw | ConvertFrom-Json
    if (-not $lifecycle.passed) { throw "$Mode smoke did not pass: $($lifecycle.error)" }
}

function Get-Mark($Launch, [string]$Name) {
    $found = @($Launch.marks | Where-Object { $_.name -eq $Name })
    if ($found.Count -eq 0) { $null } else { [double]$found[0].msSinceProcessStart }
}

function Add-LaunchLines([string]$Label, $Launches) {
    $names = [Collections.Generic.List[string]]::new()
    $pairs = [Collections.Generic.List[string]]::new()
    $intervals = @{}
    foreach ($launch in $Launches) {
        $marks = @($launch.marks)
        foreach ($mark in $marks) { if (-not $names.Contains($mark.name)) { $names.Add($mark.name) } }
        foreach ($index in 1..($marks.Count - 1)) {
            $key = "$($marks[$index - 1].name) -> $($marks[$index].name)"
            if (-not $intervals.ContainsKey($key)) { $intervals[$key] = [Collections.Generic.List[double]]::new(); $pairs.Add($key) }
            $intervals[$key].Add($marks[$index].msSinceProcessStart - $marks[$index - 1].msSinceProcessStart)
        }
    }
    foreach ($name in $names) {
        $values = @($Launches | ForEach-Object { Get-Mark $_ $name } | Where-Object { $null -ne $_ })
        Add-Line "[timing] $Label since process start, ${name}: $(Get-Stats $values)"
    }
    foreach ($key in $pairs) {
        Add-Line "[timing] $Label interval, ${key}: $(Get-Stats @($intervals[$key]))"
    }
}

function Measure-Launch([string]$Label, [string]$Mode, [string]$Source, [int]$Count, [scriptblock]$Prepare = {}) {
    $launches = foreach ($run in 1..$Count) {
        & $Prepare
        $output = Join-Path $OutDirectory ("launch-{0}-{1}" -f $Label.Replace(' ', '-'), $run)
        Invoke-SmokeMode $Mode $Source $output
        $log = Join-Path $env:LOCALAPPDATA 'Maple/maple.log'
        if (Test-Path $log) { Copy-Item $log (Join-Path $output 'maple.log') }
        Get-Content (Join-Path $output 'launch-timing.json') -Raw | ConvertFrom-Json
    }
    Add-Line "[timing] $Label over $Count launches; photos in grid at the end: $(@($launches | ForEach-Object { $_.photosInGrid }) -join ',') of $(@($launches | ForEach-Object { $_.expectedPhotos }) -join ','), thumbnails set: $(@($launches | ForEach-Object { $_.thumbnailsSet }) -join ',')"
    Add-LaunchLines $Label @($launches)
    , @($launches)
}

function Use-AppSettings([scriptblock]$Body) {
    $path = Join-Path $env:LOCALAPPDATA 'Maple/settings.json'
    $backup = "$path.bench-backup"
    if (Test-Path $backup) { throw "A settings backup from an earlier run exists: $backup" }
    New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
    $existed = Test-Path $path
    if ($existed) { Copy-Item $path $backup }
    try { & $Body }
    finally {
        if ($existed) { Copy-Item $backup $path -Force; Remove-Item $backup -Force }
        else { Remove-Item $path -Force -ErrorAction SilentlyContinue }
    }
}

function Set-AppSettings([hashtable]$Values) {
    $Values | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $env:LOCALAPPDATA 'Maple/settings.json')
}

function Clear-LaunchCaches([string]$Library) {
    Remove-Item (Join-Path $Library '.maple') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:LOCALAPPDATA 'Maple/local-cache') -Recurse -Force -ErrorAction SilentlyContinue
}

function New-PhotoFolder([string]$Name, [int]$Count, [string]$Source) {
    $folder = Join-Path $fixtures $Name
    Remove-Item $folder -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory $folder | Out-Null
    foreach ($index in 1..$Count) {
        $target = Join-Path $folder ('IMG_{0:D4}.dng' -f $index)
        try { New-Item -ItemType HardLink -Path $target -Target $Source | Out-Null }
        catch { [IO.File]::Copy($Source, $target) }
    }
    $folder
}

$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1)
Add-Line "[timing] host: $([Environment]::OSVersion.VersionString), $env:PROCESSOR_ARCHITECTURE, $($cpu.Name), $([Environment]::ProcessorCount) logical cores"
Add-Line "[timing] adapters: $((Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join '; ')"
Add-Line "[timing] source: $(& git -C $repo rev-parse HEAD)"

Invoke-Stage 'native calls and loopback client benchmarks (dotnet test)' {
    $env:MAPLE_BENCH_OUT = $OutDirectory
    $log = Join-Path $OutDirectory 'bench-dotnet-test.log'
    dotnet test (Join-Path $repo 'src/windows/Maple.WinUI.Tests/Maple.WinUI.Tests.csproj') -c Release --no-build `
        --filter 'Category=Benchmark|FullyQualifiedName~DisplayImageCacheConcurrencyTests' `
        --logger 'console;verbosity=detailed' *>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { throw "dotnet test exited $LASTEXITCODE" }
    $cacheLine = Select-String -Path $log -Pattern 'tiles: one-at-a-time' | Select-Object -First 1
    if (-not $cacheLine) { throw 'DisplayImageCacheConcurrencyTests printed no timing line' }
    Add-Content $nativeReport "[bench] W07 DisplayImageCacheConcurrencyTests: $($cacheLine.Line.Trim())"
    $text = Get-Content $nativeReport -Raw
    foreach ($expected in @('W15 open', 'W15 CPU-fallback tick', 'W16 export, queue', 'W17 listing', 'D9 per tile, first fetch', 'D9 200 thumbnails, width 16', 'tiles: AVIF')) {
        if (-not $text.Contains($expected)) { throw "benchmark line missing: $expected" }
    }
}

$smokeInput = Join-Path $fixtures 'input.dng'
Copy-Item (Join-Path $repo 'src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng') $smokeInput -Force

Invoke-Stage 'launch to first frame of the real app (lifecycle smoke mode launch-timing)' {
    Add-Line '[timing] marks are milliseconds since the process start time; root-loaded is the Loaded event, first-render-after-loaded the first composition frame tick after it (root-loaded-before-hook would mean Loaded had already fired when the smoke attached, an upper bound); this launch restores no library and the Cloud Files setting is off'
    Measure-Launch 'W01 bare' 'launch-timing' $smokeInput $bareLaunches | Out-Null
}

Invoke-Stage "launch with a $libraryPhotos-photo library, cold and warm caches (lifecycle smoke mode launch-timing-restored)" {
    if (-not $inCi) { Add-Line '[timing] skipped: this stage replaces settings.json and clears the app caches, so it runs only when GITHUB_ACTIONS is true'; return }
    $source = Join-Path $fixtures 'photo-2mp.dng'
    if (-not (Test-Path $source)) { throw "synthetic library photo missing: $source" }
    $library = New-PhotoFolder 'library-photos' $libraryPhotos $source
    Add-Line "[timing] $libraryPhotos hard links to one synthetic 1600x1250 (2 MP) uncompressed DNG, so every tile does real decode work; launches restore sources like a normal launch from a replaced settings.json (put back afterwards); cold launches empty the folder's .maple and the app's local-cache first; all-thumbnails-set is the W05 number and is absent if not reached within 60 s; grid and thumbnail marks come from collection and property change events"
    Use-AppSettings {
        $prepareCold = { Clear-LaunchCaches $library; Set-AppSettings @{ LibraryFolders = @($library) } }
        $prepareWarm = { Set-AppSettings @{ LibraryFolders = @($library) } }
        Measure-Launch 'W05 library cold' 'launch-timing-restored' $library $coldLaunches $prepareCold | Out-Null
        Measure-Launch 'W05 library warm' 'launch-timing-restored' $library $warmLaunches $prepareWarm | Out-Null
    }
}

Invoke-Stage 'launch with the Cloud Files setting on (lifecycle smoke mode launch-timing-restored)' {
    if (-not $inCi) { Add-Line '[timing] skipped: this stage replaces settings.json and starts a sync root, so it runs only when GITHUB_ACTIONS is true'; return }
    $empty = Join-Path $fixtures 'no-photos'
    New-Item -ItemType Directory -Force $empty | Out-Null
    Use-AppSettings {
        $launches = Measure-Launch 'W01 cloud-files-setting-on' 'launch-timing-restored' $empty $cloudFilesLaunches { Set-AppSettings @{ CloudFilesEnabled = $true } }
        $started = @($launches | Where-Object { $null -ne (Get-Mark $_ 'sync-root-started') }).Count
        $failed = @($launches | Where-Object { $null -ne (Get-Mark $_ 'sync-root-start-failed') }).Count
        Add-Line "[timing] W01 the sync root started in $started and failed to start in $failed of $($launches.Count) launches (the app writes the setting back to off when the start fails, so this script rewrites it before each launch)"
        if ($started -eq 0) {
            Add-Line '[timing] W01 the sync root never started on this runner: the launches above are NOT measurements with Cloud Files on'
            Get-ChildItem $OutDirectory -Filter maple.log -Recurse | Select-Object -First 1 | ForEach-Object {
                Select-String -Path $_.FullName -Pattern 'cloudfiles' | Select-Object -Last 3 | ForEach-Object { Add-Line "[timing] W01 maple.log: $($_.Line)" }
            }
        }
    }
}

Invoke-Stage 'editor open and slider tick in the real app (existing qualification mode, default render path)' {
    $photo = Join-Path $fixtures 'photo-24mp.dng'
    if (-not (Test-Path $photo)) { throw "synthetic photo missing: $photo" }
    $reports = foreach ($run in 1..$qualifyRuns) {
        $output = Join-Path $OutDirectory "qualify-$run"
        New-Item -ItemType Directory -Force $output | Out-Null
        $runPhoto = Join-Path $output 'photo-24mp.dng'
        Copy-Item $photo $runPhoto
        Start-App @() @{ MAPLE_QUALIFY_RAW = $runPhoto; MAPLE_QUALIFY_OUT = $output }
        Remove-Item $runPhoto -Force
        $one = Get-Content (Join-Path $output 'report.json') -Raw | ConvertFrom-Json
        if ($one.error) { throw "qualification run failed: $($one.error)" }
        $one
    }
    $paths = @($reports | ForEach-Object { $_.render_path } | Select-Object -Unique)
    Add-Line "[timing] W15 in the real app: 24 MP synthetic RAW, uncompressed 16-bit with no embedded preview (no decompression cost, and the Auto profile has no preview to fit), render path $($paths -join '/') (the runner has no physical GPU, so a gpu path is the software adapter); open is selection to first frame, a tick is an Exposure edit to frame ready; 20 ticks per run because the existing qualification mode fixes that count"
    Add-Line "[timing] W15 app open to first frame, per launch: $(Get-Stats @($reports | ForEach-Object { $_.decode_ms }))"
    Add-Line "[timing] W15 app slider tick, all ticks: $(Get-Stats @($reports | ForEach-Object { $_.tick_ms } | ForEach-Object { $_ }))"
    Add-Line "[timing] W15 app slider tick, per-launch medians: $(Get-Stats @($reports | ForEach-Object { $_.median_ms }))"
    Add-Line "[timing] W15 app refine frame, per-launch medians: $(Get-Stats @($reports | ForEach-Object { $_.refine_median_ms }))"
}

Invoke-Stage "grid virtualization with $gridItems photos (lifecycle smoke mode grid-virtualization)" {
    $folder = New-PhotoFolder 'grid-photos' $gridItems $smokeInput
    $output = Join-Path $OutDirectory 'grid'
    Invoke-SmokeMode 'grid-virtualization' $folder $output
    $grid = Get-Content (Join-Path $output 'grid-virtualization.json') -Raw | ConvertFrom-Json
    Add-Line "[count] W08 grid: $($grid.photos) photos in the grid, $($grid.realizedGridViewItems) tile containers realized once the count was stable for 20 polls of 15 ms ($($grid.itemsPanelChildren) panel children), viewport $($grid.viewportWidth) x $($grid.viewportHeight) DIPs (a count, one launch)"
}

Invoke-Stage 'decision 8: how a 512 px lossless PNG tile is decoded for a 192 px cell (lifecycle smoke mode tile-decode-timing)' {
    $tiles = Join-Path $fixtures 'tiles/png-512'
    $output = Join-Path $OutDirectory 'tile-decode'
    Invoke-SmokeMode 'tile-decode-timing' $tiles $output
    $decode = Get-Content (Join-Path $output 'tile-decode-timing.json') -Raw | ConvertFrom-Json
    Add-Line "[timing] D8 $($decode.tiles) PNG tiles from the display image cache, each set as the Source of an Image in the window and timed from source set to ImageOpened (an ImageFailed fails the stage); mean per tile per round after one warm-up round; the image cache is bypassed; display scale $($decode.rasterizationScale)"
    Add-Line "[timing] D8 cases: grid-binding-today is what the grid's binding does now (the bitmap has its source before it reaches the Image, no decode size); explicit-cell-decode adds DecodePixelWidth $($decode.cellPixels); in-tree-before-source lets the framework size the decode itself; forced-full-size is the full-size reference"
    foreach ($case in $decode.cases) {
        Add-Line "[timing] D8 $($case.name): $(Get-Stats @($case.perTileMeanMsPerRound))"
    }
}

Add-Line '== native and loopback benchmark lines =='
if (Test-Path $nativeReport) { Get-Content $nativeReport | ForEach-Object { Add-Line $_ } }

if ($failures.Count -gt 0) { throw ($failures -join "`n") }
