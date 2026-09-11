Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot "public\icons\app-icon-512.png"
$resourceRoot = Join-Path $projectRoot "android\app\src\main\res"
$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)

function Write-ScaledPng {
    param(
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][int]$Width,
        [Parameter(Mandatory = $true)][int]$Height,
        [Parameter(Mandatory = $true)][System.Drawing.Color]$Background,
        [Parameter(Mandatory = $true)][int]$ImageSize
    )

    $bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear($Background)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $left = [int](($Width - $ImageSize) / 2)
        $top = [int](($Height - $ImageSize) / 2)
        $graphics.DrawImage($sourceImage, $left, $top, $ImageSize, $ImageSize)
        $bitmap.Save($TargetPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

try {
    $densities = @{
        "mdpi" = @(48, 108)
        "hdpi" = @(72, 162)
        "xhdpi" = @(96, 216)
        "xxhdpi" = @(144, 324)
        "xxxhdpi" = @(192, 432)
    }

    foreach ($density in $densities.Keys) {
        $directory = Join-Path $resourceRoot "mipmap-$density"
        $iconSize = $densities[$density][0]
        $foregroundSize = $densities[$density][1]
        Write-ScaledPng (Join-Path $directory "ic_launcher.png") $iconSize $iconSize ([System.Drawing.Color]::Transparent) $iconSize
        Write-ScaledPng (Join-Path $directory "ic_launcher_round.png") $iconSize $iconSize ([System.Drawing.Color]::Transparent) $iconSize
        Write-ScaledPng (Join-Path $directory "ic_launcher_foreground.png") $foregroundSize $foregroundSize ([System.Drawing.Color]::Transparent) $foregroundSize
    }

    # Keep the splash screen on the brand background to avoid a white flash.
    Get-ChildItem -LiteralPath $resourceRoot -Recurse -Filter "splash.png" -File | ForEach-Object {
        $splashPath = $_.FullName
        $splashImage = [System.Drawing.Image]::FromFile($splashPath)
        try {
            $width = $splashImage.Width
            $height = $splashImage.Height
        }
        finally {
            $splashImage.Dispose()
        }
        $brandSize = [int]([Math]::Min($width, $height) * 0.28)
        Write-ScaledPng $splashPath $width $height ([System.Drawing.ColorTranslator]::FromHtml("#071116")) $brandSize
    }
}
finally {
    $sourceImage.Dispose()
}

Write-Output "ANDROID_BRANDING_READY"
