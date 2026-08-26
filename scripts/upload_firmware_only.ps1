[CmdletBinding()]
param(
    [string]$Port = "COM9"
)

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$platformio = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\platformio.exe"
if (-not (Test-Path -LiteralPath $platformio -PathType Leaf)) {
    $platformioCommand = Get-Command pio -ErrorAction SilentlyContinue
    if (-not $platformioCommand) {
        throw "PlatformIO is required to upload TramTrace firmware."
    }
    $platformio = $platformioCommand.Source
}

Push-Location $projectRoot
try {
    Write-Host (
        "Uploading bootloader, OTA partition table and app0 to $Port; " +
        "the NVS configuration partition at 0x9000..0xDFFF is preserved."
    )
    & $platformio run -e tramtrace -t upload --upload-port $Port
    if ($LASTEXITCODE -ne 0) {
        throw "TramTrace upload failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

Write-Host "Upload complete; saved TramTrace Wi-Fi settings were not erased."
