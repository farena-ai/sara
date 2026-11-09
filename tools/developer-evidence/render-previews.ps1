Add-Type -AssemblyName System.Drawing
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$items = Get-Content -LiteralPath (Join-Path $root 'outputs/developer-addons/evidence/previews.json') -Encoding UTF8 -Raw | ConvertFrom-Json
foreach ($item in $items) {
  $image = New-Object System.Drawing.Bitmap(1120,740)
  $g = [System.Drawing.Graphics]::FromImage($image)
  $g.Clear([System.Drawing.Color]::FromArgb(13,23,38))
  $title = New-Object System.Drawing.Font('Segoe UI',28)
  $body = New-Object System.Drawing.Font('Segoe UI',19)
  $small = New-Object System.Drawing.Font('Segoe UI',14)
  $ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235,242,250))
  $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(80,221,184))
  $g.DrawString('SYNTHETIC FIXTURE PREVIEW - NOT AN APP SCREENSHOT',$small,$accent,42,38)
  $g.DrawString([string]$item.title,$title,$ink,42,100)
  $y = 180
  foreach ($line in $item.lines) {
    $box = New-Object System.Drawing.RectangleF(42,$y,1020,110)
    $g.DrawString([string]$line,$body,$ink,$box)
    $y += 120
  }
  $g.DrawString('Offline native analyzer / no model, network, or disk scan',$small,$accent,42,680)
  $image.Save([string]$item.output,[System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $image.Dispose(); $title.Dispose(); $body.Dispose(); $small.Dispose(); $ink.Dispose(); $accent.Dispose()
  Write-Output $item.output
}
