[CmdletBinding()]
param(
    [string]$Port = "COM9"
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$platformio = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\platformio.exe"
$python = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\python.exe"
$esptool = Join-Path $env:USERPROFILE ".platformio\packages\tool-esptoolpy\esptool.py"
$firmware = Join-Path $projectRoot ".pio\build\tramtrace\firmware.bin"

foreach ($tool in @($platformio, $python, $esptool)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
        throw "Required upload tool not found: $tool"
    }
}

Push-Location $projectRoot
try {
    & $platformio run -e tramtrace
    if ($LASTEXITCODE -ne 0) {
        throw "TramTrace firmware build failed with exit code $LASTEXITCODE."
    }

    if (-not (Test-Path -LiteralPath $firmware -PathType Leaf)) {
        throw "Built firmware image not found: $firmware"
    }

    $appPartitionSize = 0x640000
    $firmwareSize = (Get-Item -LiteralPath $firmware).Length
    if ($firmwareSize -gt $appPartitionSize) {
        throw (
            "Firmware image is $firmwareSize bytes, larger than the " +
            "$appPartitionSize-byte app0 partition."
        )
    }

    Write-Host (
        "Uploading application only at 0x10000; " +
        "NVS 0x9000..0xDFFF will not be written or erased."
    )
    & $python $esptool `
        --chip esp32 `
        --port $Port `
        --baud 460800 `
        --before default_reset `
        --after hard_reset `
        write_flash `
        --verify `
        0x10000 $firmware
    if ($LASTEXITCODE -ne 0) {
        throw "Application-only upload failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

Write-Host "Application-only upload complete; the uploader did not touch NVS."
