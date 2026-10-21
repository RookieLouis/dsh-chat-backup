#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$Destination = '',
  [string]$ConfigBackupRoot = ''
)
$ErrorActionPreference = 'Stop'
$pluginPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$profilePath = [IO.Path]::GetFullPath($Profile)
$packagePath = Join-Path $profilePath 'package.json'
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw "DSH desktop profile missing: $packagePath" }
$package = [IO.File]::ReadAllText($packagePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not $package.dsh.profile.bundles) { throw 'This profile has no DSH bundle list.' }
if ($Destination) {
  if (-not [IO.Path]::IsPathRooted($Destination)) { throw 'Destination must be an absolute directory path.' }
  if (-not (Test-Path -LiteralPath ([IO.Path]::GetPathRoot($Destination)))) { throw "Backup drive unavailable: $Destination" }
}
if (-not $ConfigBackupRoot) { $ConfigBackupRoot = Join-Path $env:USERPROFILE '.dsh\backups\dsh-chat-backup-install' }
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source

# Back up every existing profile file that installation or the configuration edit may change.
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmssfff')
$configBackup = Join-Path $ConfigBackupRoot $stamp
New-Item -ItemType Directory -Path $configBackup -Force | Out-Null
foreach ($name in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml')) {
  $source = Join-Path $profilePath $name
  if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination (Join-Path $configBackup $name) }
}
@{ profile = $profilePath; plugin = $pluginPath; destination = $Destination; createdAt = (Get-Date).ToString('o') } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $configBackup 'install-info.json') -Encoding UTF8

Push-Location $profilePath
try {
  & $pnpm add "dsh-chat-backup@link:$pluginPath" --ignore-scripts --offline
  if ($LASTEXITCODE -ne 0) { throw "pnpm failed ($LASTEXITCODE); original configuration: $configBackup" }
} finally { Pop-Location }

$package = [IO.File]::ReadAllText($packagePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if (@($package.dsh.profile.bundles) -notcontains 'dsh-chat-backup') {
  $package.dsh.profile.bundles = @($package.dsh.profile.bundles) + @('dsh-chat-backup')
  [IO.File]::WriteAllText($packagePath, ($package | ConvertTo-Json -Depth 100) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}
$patchPath = Join-Path $profilePath 'cordis.patch.yml'
$patch = if (Test-Path -LiteralPath $patchPath) { [IO.File]::ReadAllText($patchPath) } else { '' }
if ($patch -notmatch '(?m)^\s*- id: dsh-chat-backup\s*$') {
  # JSON quoted strings are valid YAML strings and preserve Windows backslashes.
  $quotedDestination = ConvertTo-Json -InputObject $Destination -Compress
  $newPatch = $patch.TrimEnd() + [Environment]::NewLine + @"
- id: dsh-chat-backup
  name: dsh-chat-backup
  config:
    enabled: true
    destinationRoot: $quotedDestination
    intervalMinutes: 5
    backupAfterTurn: true
    debounceSeconds: 10
"@ + [Environment]::NewLine
  [IO.File]::WriteAllText($patchPath, $newPatch, (New-Object Text.UTF8Encoding($false)))
}
Write-Output "Installed: $pluginPath"
Write-Output "Profile configuration backup: $configBackup"
if ($Destination) { Write-Output "Initial conversation backup location: $Destination (existing settings are preserved)" }
else { Write-Output 'Choose the conversation backup location inside DSH on first launch; change it later on the plugin page.' }
Write-Output 'The plugin becomes active after the next DSH restart. This installer does not interrupt running conversations.'
