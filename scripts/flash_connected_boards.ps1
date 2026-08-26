[CmdletBinding()]
param(
    [string[]]$Ports = @("COM9", "COM20")
)

$ErrorActionPreference = "Stop"
$uploader = Join-Path $PSScriptRoot "upload_firmware_only.ps1"

foreach ($port in $Ports) {
    if ($port -notmatch '^COM\d+$') {
        throw "Invalid serial port: $port"
    }
    $device = Get-CimInstance Win32_PnPEntity | Where-Object {
        $_.Name -match "\($([regex]::Escape($port))\)$"
    } | Select-Object -First 1
    if (-not $device) {
        throw "No connected serial device was found on $port."
    }
    if ($device.Name -notmatch 'USB-SERIAL CH340') {
        throw "Refusing to flash unexpected device on $port`: $($device.Name)"
    }
}

foreach ($port in $Ports) {
    Write-Host "Flashing TramTrace on $port."
    & $uploader -Port $port
}

Write-Host "All requested TramTrace boards were flashed successfully."
