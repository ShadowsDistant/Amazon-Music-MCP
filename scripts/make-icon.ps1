# Renders assets/icon.png (512x512): the Amazon Music mark — blue-gradient "music" wordmark
# with the smile arrow on white — using System.Drawing (no image toolchain needed).
# Run once: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Src = Split-Path -Parent $PSScriptRoot
$out = Join-Path $Src 'assets\icon.png'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

# Master is drawn at 512 and downsampled; the drawing coordinates below assume 512.
$size = 512
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::White)

$c1 = [System.Drawing.Color]::FromArgb(255, 26, 111, 183)   # #1A6FB7
$c2 = [System.Drawing.Color]::FromArgb(255, 62, 179, 229)   # #3EB3E5
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Rectangle 0, 0, $size, $size), $c1, $c2, 35

# Wordmark "music" (lowercase, semibold), centred a little above the middle.
$fontFamily = $null
foreach ($name in @('Segoe UI Semibold', 'Segoe UI', 'Arial')) {
  try { $fontFamily = New-Object System.Drawing.FontFamily $name; break } catch {}
}
$style = [System.Drawing.FontStyle]::Bold
if ($fontFamily.Name -like 'Segoe UI Semibold') { $style = [System.Drawing.FontStyle]::Regular }
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$path.AddString('music', $fontFamily, [int]$style, 150, (New-Object System.Drawing.RectangleF 0, 100, $size, 240), $fmt)
$g.FillPath($brush, $path)

# The smile.
$pen = New-Object System.Drawing.Pen $brush, 22
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawBezier($pen, 24, 300, 120, 380, 320, 400, 448, 328)

# The arrow head at the right end of the smile.
$head = New-Object System.Drawing.Drawing2D.GraphicsPath
$head.AddBeziers([System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF 404, 302),
  (New-Object System.Drawing.PointF 430, 293), (New-Object System.Drawing.PointF 466, 289), (New-Object System.Drawing.PointF 488, 295),
  (New-Object System.Drawing.PointF 494, 330), (New-Object System.Drawing.PointF 482, 360), (New-Object System.Drawing.PointF 456, 373),
  (New-Object System.Drawing.PointF 468, 350), (New-Object System.Drawing.PointF 470, 330), (New-Object System.Drawing.PointF 465, 315),
  (New-Object System.Drawing.PointF 450, 313), (New-Object System.Drawing.PointF 430, 316), (New-Object System.Drawing.PointF 406, 320)
))
$head.CloseFigure()
$g.FillPath($brush, $head)

$g.Dispose()

# Emit several sizes: a client that looks for a small icon should not have to scale a 512px one.
foreach ($px in 48, 96, 256, 512) {
  $small = New-Object System.Drawing.Bitmap $px, $px
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $sg.Clear([System.Drawing.Color]::White)
  $sg.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, $px, $px))
  $sg.Dispose()
  $path = Join-Path (Split-Path $out) "icon-$px.png"
  $small.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose()
  Write-Host "Wrote $path"
  if ($px -eq 512) { Copy-Item $path $out -Force }
}
$bmp.Dispose()
Write-Host "Wrote $out"
