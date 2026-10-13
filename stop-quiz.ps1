[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
$serverPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'server.cjs')).Path
$escapedPath = [regex]::Escape($serverPath)
$serverArgument = '(?:^|\s)(?:"' + $escapedPath + '"|' + $escapedPath + ')(?=\s|$)'
$servers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $serverArgument })
if (-not $servers.Count) {
  Write-Host 'This quiz server is already stopped.'
  return
}
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($quizServer in $servers) {
  $owner = Invoke-CimMethod -InputObject $quizServer -MethodName GetOwner -WhatIf:$false
  if ($owner.ReturnValue -ne 0 -or ($owner.Domain + '\' + $owner.User) -ne $currentUser) {
    throw 'Refusing to stop a server owned by another user.'
  }
  if ($PSCmdlet.ShouldProcess("Quiz server PID $($quizServer.ProcessId)", 'Stop')) {
    Stop-Process -Id $quizServer.ProcessId -ErrorAction Stop
    Write-Host 'Quiz server stopped.'
  }
}
