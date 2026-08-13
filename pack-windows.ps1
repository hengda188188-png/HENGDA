param([string]$Output = "$PSScriptRoot\dist\PhotoRelay-portable")

$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$native = Join-Path $project 'native\PhotoRelayNative.csproj'
$publish = Join-Path $project 'dist\native-publish'
$outputFull = [IO.Path]::GetFullPath($Output)

dotnet restore $native -r win-x64 --configfile (Join-Path $project 'native\NuGet.Config')
if ($LASTEXITCODE -ne 0) { throw "dotnet restore failed ($LASTEXITCODE)" }
dotnet publish $native -c Release -r win-x64 --self-contained true --no-restore -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $publish
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }

if (Test-Path -LiteralPath $outputFull) { Remove-Item -LiteralPath $outputFull -Recurse -Force }
New-Item -ItemType Directory -Path $outputFull | Out-Null
New-Item -ItemType Directory -Path (Join-Path $outputFull 'app') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $outputFull 'runtime') | Out-Null

Copy-Item -LiteralPath (Join-Path $publish 'PhotoRelay.exe') -Destination $outputFull
foreach ($file in @('server.mjs', 'package.json', 'README.md', 'ARCHITECTURE.md', 'feature-map.json')) {
  Copy-Item -LiteralPath (Join-Path $project $file) -Destination (Join-Path $outputFull 'app')
}
Copy-Item -LiteralPath (Join-Path $project 'src') -Destination (Join-Path $outputFull 'app\src') -Recurse
Copy-Item -LiteralPath (Join-Path $project 'web') -Destination (Join-Path $outputFull 'app\web') -Recurse
Copy-Item -LiteralPath (Get-Command node -ErrorAction Stop).Source -Destination (Join-Path $outputFull 'runtime\node.exe')

$quickStart = @(
  'PhotoRelay portable edition',
  '===========================',
  '1. Double-click PhotoRelay.exe.',
  '2. Choose a durable data folder on another drive or NAS.',
  '3. Start the central service.',
  '4. Open the displayed shared URL on other computers.',
  '',
  'No separate Node.js or .NET installation is required.'
)
$quickStart | Set-Content -LiteralPath (Join-Path $outputFull 'QUICK-START.txt') -Encoding UTF8
Write-Host "Portable build ready: $outputFull"
