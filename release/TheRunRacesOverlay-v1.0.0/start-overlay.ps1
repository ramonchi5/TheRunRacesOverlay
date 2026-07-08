$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $scriptDir "server.js"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if ($nodeCommand) {
  & $nodeCommand.Path $server @args
  exit $LASTEXITCODE
}

if (Test-Path $bundledNode) {
  & $bundledNode $server @args
  exit $LASTEXITCODE
}

Write-Error "Node.js was not found. Install Node.js or start this from Codex with the bundled runtime available."
