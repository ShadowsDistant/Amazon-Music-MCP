<#
.SYNOPSIS
  Packages the server as a Claude Desktop extension (.mcpb) so it gets a real icon.

.WHY
  Claude Desktop draws a letter avatar for servers configured in claude_desktop_config.json
  and ignores the icons the server advertises over MCP. Installed extensions are different:
  they live in %APPDATA%\Claude\Claude Extensions\<id>\ with a manifest.json and an icon.png,
  and that icon is what the Connectors list shows. So we ship one.

.USAGE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-extension.ps1
  Then double-click the .mcpb it prints (or drag it onto Claude Desktop's Extensions page).
#>
$ErrorActionPreference = 'Stop'

$Src   = Split-Path -Parent $PSScriptRoot
$Root  = Join-Path $env:USERPROFILE '.amazon-music-mcp'
$Build = Join-Path $Root 'build'
$Stage = Join-Path $Root 'pack'
$Out   = Join-Path $Root 'amazon-music.mcpb'

if (-not (Test-Path (Join-Path $Build 'dist\index.js'))) { throw "Build first: scripts\setup.ps1" }

$pkg = Get-Content (Join-Path $Src 'package.json') -Raw | ConvertFrom-Json

if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

Write-Host 'Staging files...'
Copy-Item (Join-Path $Build 'dist') $Stage -Recurse
Remove-Item (Join-Path $Stage 'dist\ui\swatches.html') -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Build 'package.json') $Stage
$lock = Join-Path $Build 'package-lock.json'
if (Test-Path $lock) { Copy-Item $lock $Stage }

# Runtime dependencies only: typescript and esbuild are build tools and would double the size.
$Node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$NpmCli = Join-Path $env:ProgramFiles 'nodejs\node_modules\npm\bin\npm-cli.js'
Write-Host 'Installing runtime dependencies...'
Push-Location $Stage
try {
  & $Node $NpmCli install --omit=dev --no-audit --no-fund --loglevel=error --legacy-peer-deps
  if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
} finally { Pop-Location }
Copy-Item (Join-Path $Src 'assets\icon-256.png') (Join-Path $Stage 'icon.png')
if (Test-Path (Join-Path $Src 'README.md')) { Copy-Item (Join-Path $Src 'README.md') $Stage }
# The GPL requires the licence text to travel with the program.
if (Test-Path (Join-Path $Src 'LICENSE'))   { Copy-Item (Join-Path $Src 'LICENSE') $Stage }

# The server reads its own paths from config.ts, which defaults to %USERPROFILE%\.amazon-music-mcp,
# so no env block is needed here — the existing Edge profile and sign-in carry over.
$manifest = [ordered]@{
  manifest_version = '0.3'
  name             = 'amazon-music'
  display_name     = 'Amazon Music'
  version          = $pkg.version
  description      = "Play and control Amazon Music through a background Microsoft Edge tab."
  long_description = "Controls the Amazon Music web player in a private, off-screen Microsoft Edge window: search and play, queue, transport, volume, shuffle and repeat, likes and playlists, synced lyrics, and an interactive player widget. No Amazon API is used and no credentials are handled by the server - you sign in once yourself in the window it shows you."
  author           = [ordered]@{ name = 'shado' }
  icon             = 'icon.png'
  server           = [ordered]@{
    type        = 'node'
    entry_point = 'dist/index.js'
    mcp_config  = [ordered]@{
      command = 'node'
      args    = @('${__dirname}/dist/index.js')
    }
  }
  keywords         = @('music', 'amazon music', 'player', 'audio', 'lyrics', 'mcp', 'browser automation')
  license          = 'GPL-3.0-or-later'
  compatibility    = [ordered]@{
    claude_desktop = '>=0.10.0'
    platforms      = @('win32')
    runtimes       = [ordered]@{ node = '>=20.0.0' }
  }
}
$manifest | ConvertTo-Json -Depth 10 | Out-File (Join-Path $Stage 'manifest.json') -Encoding utf8

if (Test-Path $Out) { Remove-Item $Out -Force }
Write-Host 'Compressing...'
# Neither Compress-Archive nor ZipFile::CreateFromDirectory can be used here: on Windows
# PowerShell 5.1 both write BACKSLASH path separators, which the ZIP format does not allow
# and unpackers mishandle. Add each entry by hand with a forward-slash name.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fs = [System.IO.File]::Open($Out, [System.IO.FileMode]::CreateNew)
try {
  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $prefix = (Resolve-Path $Stage).Path.TrimEnd('\') + '\'
    foreach ($f in Get-ChildItem $Stage -Recurse -File) {
      $name = $f.FullName.Substring($prefix.Length).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $zip.Dispose() }
} finally { $fs.Dispose() }
Remove-Item $Stage -Recurse -Force

$size = [math]::Round((Get-Item $Out).Length / 1MB, 1)
Write-Host ""
Write-Host "Built $Out ($size MB)"
Write-Host "Install it: double-click that file, or drag it onto Claude Desktop > Settings > Extensions."
Write-Host "Afterwards remove the old entry so the connector is not listed twice:"
Write-Host "  node `"$Build\scripts\install.mjs`" --remove"
