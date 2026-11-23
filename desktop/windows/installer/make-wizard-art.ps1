# Z2 (polish): the pictures Setup shows (Inno Setup WizardImageFile / WizardSmallImageFile).
# Before, Setup showed Inno's stock pictures (a generic computer and disc). These are made from the
# app's own icon and theme colors, so the installer looks like the app it installs.
#
#   pwsh desktop/windows/installer/make-wizard-art.ps1
#
# Writes wizard-large.bmp (164x314), wizard-large-2x.bmp (328x628), wizard-small.bmp (55x55) and
# wizard-small-2x.bmp (110x110) beside this script. Run it again when the icon or the colors change
# and commit the four files. No downloads, no image service: System.Drawing only.
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$icon = [System.Drawing.Image]::FromFile((Join-Path $here '..\..\..\web\icon-512.png'))

# Theme colors (web/theme.css, night): the page, the raised surface, the accent.
$bgTop = [System.Drawing.Color]::FromArgb(255, 0x1c, 0x16, 0x30)
$bgBottom = [System.Drawing.Color]::FromArgb(255, 0x0f, 0x0d, 0x17)
$accent = [System.Drawing.Color]::FromArgb(255, 0xa7, 0x8b, 0xfa)
$text = [System.Drawing.Color]::FromArgb(255, 0xee, 0xe9, 0xf3)
$muted = [System.Drawing.Color]::FromArgb(255, 0xa8, 0xa0, 0xb8)

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $bgTop, $bgBottom, 90.0
  $g.FillRectangle($brush, $rect)
  $brush.Dispose()
  return @{ bmp = $bmp; g = $g }
}

# Her picture in a circle with a thin accent ring.
function Add-Portrait($g, [single]$cx, [single]$cy, [single]$d, [single]$ring) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse($cx - $d / 2, $cy - $d / 2, $d, $d)
  $state = $g.Save()
  $g.SetClip($path)
  $g.DrawImage($icon, $cx - $d / 2, $cy - $d / 2, $d, $d)
  $g.Restore($state)
  $pen = New-Object System.Drawing.Pen $accent, $ring
  $g.DrawEllipse($pen, $cx - $d / 2, $cy - $d / 2, $d, $d)
  $pen.Dispose()
  $path.Dispose()
}

# A soft glow behind the picture (a few faint circles), so it sits in the page like the app's orb.
function Add-Glow($g, [single]$cx, [single]$cy, [single]$d) {
  for ($i = 6; $i -ge 1; $i--) {
    $r = $d / 2 + $i * ($d * 0.07)
    $c = [System.Drawing.Color]::FromArgb(7, $accent.R, $accent.G, $accent.B)
    $b = New-Object System.Drawing.SolidBrush $c
    $g.FillEllipse($b, $cx - $r, $cy - $r, $r * 2, $r * 2)
    $b.Dispose()
  }
}

function Save-Large([int]$scale, [string]$name) {
  $w = 164 * $scale; $h = 314 * $scale
  $c = New-Canvas $w $h
  $g = $c.g
  $d = 104 * $scale
  $cx = $w / 2; $cy = 96 * $scale
  Add-Glow $g $cx $cy $d
  Add-Portrait $g $cx $cy $d (1.5 * $scale)
  $center = New-Object System.Drawing.StringFormat
  $center.Alignment = 'Center'
  $title = New-Object System.Drawing.Font 'Segoe UI Semibold', (20 * $scale), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $small = New-Object System.Drawing.Font 'Segoe UI', (10.5 * $scale), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $tb = New-Object System.Drawing.SolidBrush $text
  $mb = New-Object System.Drawing.SolidBrush $muted
  $g.DrawString('Sara', $title, $tb, (New-Object System.Drawing.RectangleF 0, (166 * $scale), $w, (30 * $scale)), $center)
  $g.DrawString("Your own AI companion`nand assistant", $small, $mb, (New-Object System.Drawing.RectangleF (8 * $scale), (198 * $scale), ($w - 16 * $scale), (40 * $scale)), $center)
  # A short accent line at the foot, like the app's active marks.
  $pen = New-Object System.Drawing.Pen $accent, (2 * $scale)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawLine($pen, ($w / 2 - 14 * $scale), (286 * $scale), ($w / 2 + 14 * $scale), (286 * $scale))
  $pen.Dispose(); $title.Dispose(); $small.Dispose(); $tb.Dispose(); $mb.Dispose(); $g.Dispose()
  $c.bmp.Save((Join-Path $here $name), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $c.bmp.Dispose()
}

function Save-Small([int]$scale, [string]$name) {
  $s = 55 * $scale
  $c = New-Canvas $s $s
  Add-Portrait $c.g ($s / 2) ($s / 2) (45 * $scale) (1.25 * $scale)
  $c.g.Dispose()
  $c.bmp.Save((Join-Path $here $name), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $c.bmp.Dispose()
}

Save-Large 1 'wizard-large.bmp'
Save-Large 2 'wizard-large-2x.bmp'
Save-Small 1 'wizard-small.bmp'
Save-Small 2 'wizard-small-2x.bmp'
$icon.Dispose()
Get-ChildItem $here -Filter 'wizard-*.bmp' | ForEach-Object { '{0}  {1} bytes' -f $_.Name, $_.Length }
