param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$address = 'http://127.0.0.1:8765'
function Get-QuizHealth {
  try { return Invoke-RestMethod "$address/health" -TimeoutSec 1 } catch { return $null }
}
try {
  $health = Get-QuizHealth
  if ($health -and $health.server -ne 'gate-cse-quiz-server-v1') { throw 'Port 8765 is used by another service.' }
  if (-not $health) {
    $connection = [System.Net.Sockets.TcpClient]::new()
    try { $connection.Connect('127.0.0.1', 8765); $occupied = $true } catch { $occupied = $false } finally { $connection.Dispose() }
    if ($occupied) { throw 'Port 8765 is used by another service. Close that service and try again.' }
    $command = Get-Command node -ErrorAction SilentlyContinue
    $nodePath = if ($command) { $command.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js is required to run the local quiz server.' }
    $serverPath = Join-Path $PSScriptRoot 'server.cjs'
    $process = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    for ($count = 0; $count -lt 40 -and -not $health; $count++) {
      Start-Sleep -Milliseconds 100
      $health = Get-QuizHealth
      if ($process.HasExited -and -not $health) { throw 'The quiz server could not start.' }
    }
    if (-not $health -or $health.server -ne 'gate-cse-quiz-server-v1') { throw 'The quiz server did not respond.' }
  }
  if (-not $NoBrowser) { Start-Process "$address/" }
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
