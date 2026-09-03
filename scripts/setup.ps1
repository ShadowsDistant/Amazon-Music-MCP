<#
.SYNOPSIS
  Builds the Amazon Music MCP server into %USERPROFILE%\.amazon-music-mcp\build
  (outside OneDrive: node_modules and the Edge profile must not be synced;
  outside AppData: see the MSIX note below).

.USAGE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 [-Install] [-Autostart]

  -Install    also writes the "amazon-music" entry into Claude Desktop's config.
  -Autostart  also creates a Startup-folder shortcut that launches the background
              Edge at Windows sign-in (so music is ready before Claude Desktop opens).
#>
param([switch]$Install, [switch]$Autostart)

$ErrorActionPreference = 'Stop'

$Src   = Split-Path -Parent $PSScriptRoot
# Not under AppData: Claude Desktop is an MSIX package and AppData writes from it (and from the
# Edge it launches) are virtualized into its LocalCache, invisible to the login-time launcher.
$Root  = Join-Path $env:USERPROFILE '.amazon-music-mcp'
$Build = Join-Path $Root 'build'
$Node  = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$NpmCli = Join-Path $env:ProgramFiles 'nodejs\node_modules\npm\bin\npm-cli.js'

if (-not (Test-Path $Node))   { throw "node.exe not found at $Node" }
if (-not (Test-Path $NpmCli)) { throw "npm-cli.js not found at $NpmCli" }

# The machine PATH contains an unbalanced quote that breaks any .cmd shim; sanitize per-process
# and call node/npm-cli.js directly instead of npm.cmd / tsc.cmd.
$env:PATH = ($env:PATH -split ';' | ForEach-Object { $_ -replace '"', '' } | Where-Object { $_.Trim() -ne '' }) -join ';'

foreach ($d in @($Build, (Join-Path $Root 'profile'), (Join-Path $Root 'logs'))) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

Write-Host "Syncing sources -> $Build"
Copy-Item (Join-Path $Src 'package.json') $Build -Force
Copy-Item (Join-Path $Src 'tsconfig.json') $Build -Force
$lock = Join-Path $Src 'package-lock.json'
if (Test-Path $lock) { Copy-Item $lock $Build -Force }
else { Remove-Item (Join-Path $Build 'package-lock.json') -Force -ErrorAction SilentlyContinue }
foreach ($dir in @('src', 'scripts', 'ui', 'assets')) {
  $from = Join-Path $Src $dir
  if (-not (Test-Path $from)) { continue }
  $dst = Join-Path $Build $dir
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $from $dst -Recurse
}

Push-Location $Build
try {
  # --legacy-peer-deps: ext-apps declares react as a peer; the server never needs it.
  if (Test-Path (Join-Path $Build 'package-lock.json')) {
    Write-Host 'npm ci'
    & $Node $NpmCli ci --no-audit --no-fund --loglevel=error --legacy-peer-deps
  } else {
    Write-Host 'npm install'
    & $Node $NpmCli install --no-audit --no-fund --loglevel=error --legacy-peer-deps
  }
  if ($LASTEXITCODE -ne 0) { throw "npm failed with exit code $LASTEXITCODE" }

  Write-Host 'tsc'
  & $Node (Join-Path $Build 'node_modules\typescript\bin\tsc') -p (Join-Path $Build 'tsconfig.json')
  if ($LASTEXITCODE -ne 0) { throw "tsc failed with exit code $LASTEXITCODE" }

  Write-Host 'ui bundle'
  & $Node (Join-Path $Build 'scripts\build-ui.mjs')
  if ($LASTEXITCODE -ne 0) { throw "build-ui failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# Keep the lockfile with the sources for reproducible builds.
Copy-Item (Join-Path $Build 'package-lock.json') $Src -Force

Write-Host "Built: $(Join-Path $Build 'dist\index.js')"

if ($Install) {
  & $Node (Join-Path $Build 'scripts\install.mjs')
  if ($LASTEXITCODE -ne 0) { throw "install.mjs failed with exit code $LASTEXITCODE" }
}
if ($Autostart) {
  & $Node (Join-Path $Build 'scripts\autostart.mjs')
  if ($LASTEXITCODE -ne 0) { throw "autostart.mjs failed with exit code $LASTEXITCODE" }
}
