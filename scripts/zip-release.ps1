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
Add-Type -AssemblyName System.IO.Compression
$temporaryPath = $targetPath + '.tmp-' + [guid]::NewGuid().ToString('N')
$archive = $null
try {
    $archive = [IO.Compression.ZipFile]::Open($temporaryPath,[IO.Compression.ZipArchiveMode]::Create)
    function Write-ArchiveDirectory([string]$Directory,[string]$Prefix) {
        $entries = @(Get-ChildItem -LiteralPath $Directory -Force)
        if ($entries.Count -eq 0) { [void]$archive.CreateEntry($Prefix); return }
        foreach ($entry in $entries) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Archive input must not contain links' }
            $name = $Prefix + $entry.Name
            if ($entry.PSIsContainer) { Write-ArchiveDirectory $entry.FullName ($name + '/') }
            else { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$entry.FullName,$name,[IO.Compression.CompressionLevel]::Optimal) }
        }
    }
    Write-ArchiveDirectory $sourcePath ((Split-Path -Leaf $sourcePath) + '/')
    $archive.Dispose(); $archive = $null
    [IO.File]::Move($temporaryPath,$targetPath)
} finally {
    if ($archive) { $archive.Dispose() }
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
}
