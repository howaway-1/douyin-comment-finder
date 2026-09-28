$ErrorActionPreference = 'Stop'
$toolRoot = $PSScriptRoot
$port = if ($env:DCF_PORT) { [int]$env:DCF_PORT } else { 8765 }
if ($port -lt 1024 -or $port -gt 65535) { throw 'Invalid port.' }
$baseUrl = "http://127.0.0.1:$port"
try {
    $existing = Invoke-RestMethod -Uri "$baseUrl/api/state" -TimeoutSec 2
    if ($existing.appId -eq 'douyin-comment-finder') { Start-Process $baseUrl; exit 0 }
    throw 'This port belongs to another application. Set DCF_PORT to another port.'
} catch {
    if ($_.Exception.Message -like '*belongs to another*') { throw }
}
$nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundledNode) { $nodePath = $bundledNode }
}
if (-not $nodePath) { throw 'Node.js 20+ is required. Install Node.js and run this launcher again.' }
$localDir = Join-Path $toolRoot '.local'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$process = Start-Process -FilePath $nodePath -ArgumentList 'server.cjs' -WorkingDirectory $toolRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $localDir 'server.log') -RedirectStandardError (Join-Path $localDir 'server-error.log')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $state = Invoke-RestMethod -Uri "$baseUrl/api/state" -TimeoutSec 1
        if ($state.appId -eq 'douyin-comment-finder') { Start-Process $baseUrl; exit 0 }
    } catch {}
    if ($process.HasExited) { break }
}
throw "Could not start. Check $localDir\server-error.log"
