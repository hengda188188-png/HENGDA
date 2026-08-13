param([string]$ReleaseDirectory = "$PSScriptRoot\..\release")

$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$release = [IO.Path]::GetFullPath($ReleaseDirectory)
$portable = Join-Path $release 'PhotoRelay-portable'
$zip = Join-Path $release 'PhotoRelay-portable-win-x64.zip'
$hashFile = "$zip.sha256"

if (Test-Path -LiteralPath $release) { Remove-Item -LiteralPath $release -Recurse -Force }
New-Item -ItemType Directory -Path $release | Out-Null
& (Join-Path $project 'build-portable.ps1') -Output $portable
Compress-Archive -Path (Join-Path $portable '*') -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  PhotoRelay-portable-win-x64.zip" | Set-Content -LiteralPath $hashFile -Encoding ascii
Write-Host "Release assets ready: $zip"

