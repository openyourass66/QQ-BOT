param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../release')).TrimEnd('\') + '\'
$sourcePath = [IO.Path]::GetFullPath($Source)
$targetPath = [IO.Path]::GetFullPath($Destination)
if (!$sourcePath.StartsWith($releaseRoot,[StringComparison]::OrdinalIgnoreCase) -or !$targetPath.StartsWith($releaseRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive paths must stay inside this project release directory' }
if (![string]::Equals([IO.Path]::GetDirectoryName($sourcePath),$releaseRoot.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase) -or ![string]::Equals([IO.Path]::GetDirectoryName($targetPath),$releaseRoot.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive paths must be direct children of the release directory' }
foreach ($path in @($releaseRoot.TrimEnd('\'), $sourcePath)) {
    $entry = Get-Item -LiteralPath $path -Force
    if (!$entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Archive source and release directory must be regular directories' }
}
if (Get-Item -LiteralPath $targetPath -Force -ErrorAction SilentlyContinue) { throw 'Archive target already exists' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($sourcePath,$targetPath,[IO.Compression.CompressionLevel]::Optimal,$true)
