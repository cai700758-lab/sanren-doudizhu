$gameServerPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'server.js'))
$gameServers = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($gameServerPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}
if (-not $gameServers) {
    Write-Host 'No game server started by start.cmd is running.'
    exit 0
}
foreach ($gameServerProcess in $gameServers) {
    Stop-Process -Id $gameServerProcess.ProcessId -ErrorAction Stop
    Write-Host "Stopped game server (PID $($gameServerProcess.ProcessId))."
}
