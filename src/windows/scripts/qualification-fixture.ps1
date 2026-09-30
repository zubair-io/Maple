# Copy qualification inputs so UI autosave cannot modify the supplied fixture.
function Copy-QualificationFixture([string]$Source, [string]$DestinationDirectory) {
    New-Item -ItemType Directory -Path $DestinationDirectory -Force | Out-Null
    $destination = Join-Path $DestinationDirectory ([IO.Path]::GetFileName($Source))
    if (Test-Path -LiteralPath $destination) { throw "Qualification destination already exists: $destination" }
    $sourceXmp = [IO.Path]::ChangeExtension($Source, '.xmp')
    $destinationXmp = [IO.Path]::ChangeExtension($destination, '.xmp')
    if (Test-Path -LiteralPath $destinationXmp) { throw "Qualification sidecar destination already exists: $destinationXmp" }
    $hash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    Copy-Item -LiteralPath $Source -Destination $destination
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $hash) {
        throw 'Qualification RAW copy does not match its source.'
    }
    if (Test-Path -LiteralPath $sourceXmp) {
        $xmpHash = (Get-FileHash -LiteralPath $sourceXmp -Algorithm SHA256).Hash
        Copy-Item -LiteralPath $sourceXmp -Destination $destinationXmp
        if ((Get-FileHash -LiteralPath $destinationXmp -Algorithm SHA256).Hash -ne $xmpHash) {
            throw 'Qualification sidecar copy does not match its source.'
        }
    }
    return $destination
}
