[CmdletBinding()]
param(
  [switch]$SkipNpm,
  [string[]]$Agents = @('antigravity', 'kiro', 'claude')
)

$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$cliJs = Join-Path $repoRoot 'bin\flow-canvas.js'
if (-not (Test-Path $cliJs)) {
  throw "CLI entrypoint not found: $cliJs"
}

$nodeModulesDir = Join-Path $repoRoot 'node_modules'
if (-not ($SkipNpm -and (Test-Path $nodeModulesDir))) {
  Write-Host '[1/5] Installing Node dependencies...'
  Push-Location $repoRoot
  try {
    npm install
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host '[1/5] Skipping npm install (-SkipNpm and node_modules already present).'
}

Write-Host '[2/5] Writing CLI shims in $HOME\bin and checking user PATH...'
$binDir = Join-Path $HOME 'bin'
New-Item -ItemType Directory -Path $binDir -Force | Out-Null

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$cliJsPosix = $cliJs -replace '\\', '/'
$cmdBody = "@echo off`r`nnode `"$cliJs`" %*`r`n"
$shBody = "#!/usr/bin/env sh`nexec node `"$cliJsPosix`" `"`$@`"`n"

foreach ($shimName in @('flow-canvas', 'google-flow')) {
  [System.IO.File]::WriteAllText((Join-Path $binDir "$shimName.cmd"), $cmdBody, $utf8NoBom)
  [System.IO.File]::WriteAllText((Join-Path $binDir $shimName), $shBody, $utf8NoBom)
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathEntries = if ($userPath) { $userPath -split ';' | Where-Object { $_ -and $_.Trim() -ne '' } } else { @() }
$normBin = $binDir.TrimEnd('\').ToLowerInvariant()
$hasUserPath = $pathEntries | Where-Object { $_.Trim().TrimEnd('\').ToLowerInvariant() -eq $normBin }
if (-not $hasUserPath) {
  $updatedUserPath = (@($pathEntries) + @($binDir)) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $updatedUserPath, 'User')
  Write-Host "  Added $binDir to User PATH."
} else {
  Write-Host "  $binDir already in User PATH."
}

$procEntries = $env:Path -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }
if (-not ($procEntries | Where-Object { $_.Trim().TrimEnd('\').ToLowerInvariant() -eq $normBin })) {
  $env:Path = "$binDir;$env:Path"
}

Write-Host '[3/5] Installing bundled skills for selected agents...'
$agentRoots = @{
  antigravity = Join-Path $HOME '.gemini\config\skills'
  kiro        = Join-Path $HOME '.kiro\skills'
  claude      = Join-Path $HOME '.claude\skills'
}

$skillSourceRoot = Join-Path $repoRoot 'skills'
$skillDirs = Get-ChildItem -Path $skillSourceRoot -Directory

$selectedAgents = @()
$parsedAgents = $Agents | ForEach-Object { $_ -split ',' } | Where-Object { $_ -and $_.Trim() -ne '' }
foreach ($rawAgent in $parsedAgents) {
  $agentKey = $rawAgent.Trim().ToLowerInvariant()
  if (-not $agentRoots.ContainsKey($agentKey)) {
    throw "Unknown agent target '$rawAgent'. Supported values: antigravity, kiro, claude."
  }
  $selectedAgents += $agentKey
  $targetRoot = $agentRoots[$agentKey]
  New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null

  foreach ($skill in $skillDirs) {
    $dest = Join-Path $targetRoot $skill.Name
    if (Test-Path $dest) {
      Remove-Item -Path $dest -Recurse -Force
    }
    Copy-Item -Path $skill.FullName -Destination $dest -Recurse -Force
  }
  Write-Host ("  Synced {0} skills -> {1}" -f $skillDirs.Count, $targetRoot)
}

function Read-JsonObject {
  param([string]$Path)

  if (Test-Path $Path) {
    $raw = Get-Content -Path $Path -Raw -ErrorAction SilentlyContinue
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
      return ($raw | ConvertFrom-Json)
    }
  }
  return [pscustomobject]@{}
}

function Write-JsonObject {
  param(
    [string]$Path,
    [object]$Object,
    [System.Text.Encoding]$Encoding
  )

  $parentDir = Split-Path -Path $Path -Parent
  New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
  $jsonText = ($Object | ConvertTo-Json -Depth 32) + "`n"
  [System.IO.File]::WriteAllText($Path, $jsonText, $Encoding)
}

function Stop-ClaudeDesktopProcesses {
  $running = Get-Process -Name 'Claude*' -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host '  Stopping running Claude Desktop processes so config changes are not overwritten on exit...'
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
}

function Update-ClaudeDesktopConfig {
  param(
    [string]$ConfigPath,
    [string]$NodeExe,
    [string]$CliScript,
    [System.Text.Encoding]$Encoding
  )

  $configObj = Read-JsonObject -Path $ConfigPath
  $existingServers = $configObj.PSObject.Properties['mcpServers']
  if ($null -eq $existingServers -or $null -eq $existingServers.Value) {
    $configObj | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{}) -Force
  }

  $entry = [pscustomobject]@{
    command = $NodeExe
    args    = @($CliScript, 'mcp')
  }
  $configObj.mcpServers | Add-Member -NotePropertyName 'google-flow' -NotePropertyValue $entry -Force
  Write-JsonObject -Path $ConfigPath -Object $configObj -Encoding $Encoding
  Write-Host "  Registered google-flow MCP -> $ConfigPath"
}

function Install-ClaudeDesktopExtension {
  param(
    [string]$ProfileDir,
    [string]$CliScript,
    [System.Text.Encoding]$Encoding
  )

  $extId = 'local.solgates.google-flow'
  $extDir = Join-Path $ProfileDir "Claude Extensions\$extId"
  $settingsPath = Join-Path $ProfileDir "Claude Extensions Settings\$extId.json"

  $manifestObj = [ordered]@{
    manifest_version = '0.4'
    name             = 'Google Flow'
    display_name     = 'Google Flow'
    version          = '1.0.0'
    description      = 'Google Flow (labs.google/fx/tools/flow) CDP MCP Server & Single-Tab Prompt Queue Bridge'
    long_description = 'Connects Claude Desktop to Google Flow over Chrome CDP (port 9222) for image, video, character, voice, and Art Director single-tab prompt queue workflows.'
    author           = [ordered]@{
      name = 'Solgates'
      url  = 'https://github.com/solgates/google-flow-connects'
    }
    homepage         = 'https://github.com/solgates/google-flow-connects'
    support          = 'https://github.com/solgates/google-flow-connects/issues'
    server           = [ordered]@{
      type        = 'node'
      entry_point = 'bin/flow-canvas.js'
      mcp_config  = [ordered]@{
        command = 'node'
        args    = @($CliScript, 'mcp')
      }
    }
    license          = 'MIT'
    compatibility    = [ordered]@{
      runtimes = [ordered]@{
        node = '>= 18.0.0'
      }
    }
    repository       = [ordered]@{
      type = 'git'
      url  = 'https://github.com/solgates/google-flow-connects'
    }
  }

  Write-JsonObject -Path (Join-Path $extDir 'manifest.json') -Object $manifestObj -Encoding $Encoding
  Write-JsonObject -Path $settingsPath -Object ([ordered]@{ isEnabled = $true }) -Encoding $Encoding
  Write-Host "  Installed Desktop Extension Connector -> $extDir"
}

function Install-ClaudeCoworkPlugin {
  param(
    [string]$ProfileDir,
    [string]$RepoRoot,
    [System.Text.Encoding]$Encoding
  )

  $sessionsRoot = Join-Path $ProfileDir 'local-agent-mode-sessions'
  if (-not (Test-Path $sessionsRoot)) {
    return
  }

  $sessionDirs = @()
  $accountDirs = Get-ChildItem -Path $sessionsRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'skills-plugin' }
  foreach ($accDir in $accountDirs) {
    $orgDirs = Get-ChildItem -Path $accDir.FullName -Directory -ErrorAction SilentlyContinue
    foreach ($orgDir in $orgDirs) {
      $sessionDirs += $orgDir.FullName
    }
  }

  $pluginKey = 'google-flow-connects@local-desktop-app-uploads'
  $nowIso = [DateTime]::UtcNow.ToString('o')
  $itemsToCopy = @('.claude-plugin', 'skills', 'README.md')

  foreach ($sessDir in $sessionDirs) {
    $pluginRoot = Join-Path $sessDir 'cowork_plugins\uploads\local-desktop-app-uploads\google-flow-connects'
    if (Test-Path $pluginRoot) {
      Remove-Item -Path $pluginRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $pluginRoot -Force | Out-Null

    foreach ($item in $itemsToCopy) {
      $srcPath = Join-Path $RepoRoot $item
      if (Test-Path $srcPath) {
        Copy-Item -Path $srcPath -Destination (Join-Path $pluginRoot $item) -Recurse -Force
      }
    }

    $staleMcp = Join-Path $pluginRoot '.mcp.json'
    if (Test-Path $staleMcp) {
      Remove-Item -Path $staleMcp -Force
    }

    $installedPath = Join-Path $sessDir 'cowork_plugins\installed_plugins.json'
    $installedObj = Read-JsonObject -Path $installedPath
    $installedObj | Add-Member -NotePropertyName 'version' -NotePropertyValue 2 -Force
    $pluginsProp = $installedObj.PSObject.Properties['plugins']
    if ($null -eq $pluginsProp -or $null -eq $pluginsProp.Value) {
      $installedObj | Add-Member -NotePropertyName 'plugins' -NotePropertyValue ([pscustomobject]@{}) -Force
    }

    $pluginEntries = @(
      [pscustomobject]@{
        scope       = 'user'
        installPath = $pluginRoot
        version     = '1.0.0'
        installedAt = $nowIso
        lastUpdated = $nowIso
      }
    )
    $installedObj.plugins | Add-Member -NotePropertyName $pluginKey -NotePropertyValue $pluginEntries -Force
    Write-JsonObject -Path $installedPath -Object $installedObj -Encoding $Encoding

    $coworkSettingsPath = Join-Path $sessDir 'cowork_settings.json'
    $coworkSettingsObj = Read-JsonObject -Path $coworkSettingsPath
    $enabledProp = $coworkSettingsObj.PSObject.Properties['enabledPlugins']
    if ($null -eq $enabledProp -or $null -eq $enabledProp.Value) {
      $coworkSettingsObj | Add-Member -NotePropertyName 'enabledPlugins' -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $coworkSettingsObj.enabledPlugins | Add-Member -NotePropertyName $pluginKey -NotePropertyValue $true -Force
    Write-JsonObject -Path $coworkSettingsPath -Object $coworkSettingsObj -Encoding $Encoding

    Write-Host "  Installed Cowork Plugin -> $pluginRoot"
  }
}

function Build-ClaudePluginPackage {
  param([string]$RepoRoot)

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $distDir = Join-Path $RepoRoot 'dist'
  New-Item -ItemType Directory -Path $distDir -Force | Out-Null
  $pluginFile = Join-Path $distDir 'google-flow-connects.plugin'
  if (Test-Path $pluginFile) {
    Remove-Item -Path $pluginFile -Force
  }

  $fileList = @()
  foreach ($rel in @('.claude-plugin\plugin.json', '.claude-plugin\marketplace.json', '.mcp.json', 'README.md')) {
    $full = Join-Path $RepoRoot $rel
    if (Test-Path $full) {
      $fileList += [pscustomobject]@{ FullPath = $full; EntryName = ($rel -replace '\\', '/') }
    }
  }
  $skillsDir = Join-Path $RepoRoot 'skills'
  if (Test-Path $skillsDir) {
    $rootPrefixLen = $RepoRoot.TrimEnd('\').Length + 1
    Get-ChildItem -Path $skillsDir -File -Recurse | ForEach-Object {
      $relPath = $_.FullName.Substring($rootPrefixLen) -replace '\\', '/'
      $fileList += [pscustomobject]@{ FullPath = $_.FullName; EntryName = $relPath }
    }
  }

  $archive = [System.IO.Compression.ZipFile]::Open($pluginFile, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($f in $fileList) {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $f.FullPath,
        $f.EntryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }

  Write-Host ("  Built plugin bundle ({0} files) -> {1}" -f $fileList.Count, $pluginFile)
}

if ($selectedAgents -contains 'claude') {
  Write-Host '[4/5] Registering Google Flow in Claude Desktop (Connectors, Plugins & Config)...'
  Build-ClaudePluginPackage -RepoRoot $repoRoot
  Stop-ClaudeDesktopProcesses

  $nodeExe = (Get-Command node).Source
  $claudeTargets = @((Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'))
  $msixPackages = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Packages') -Filter 'Claude_*' -Directory -ErrorAction SilentlyContinue
  foreach ($pkg in $msixPackages) {
    $claudeTargets += Join-Path $pkg.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json'
  }
  $claudeDataDirs = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Claude-Data') -Filter 'claude_*' -Directory -ErrorAction SilentlyContinue
  foreach ($dataDir in $claudeDataDirs) {
    $claudeTargets += Join-Path $dataDir.FullName 'claude_desktop_config.json'
    Install-ClaudeDesktopExtension -ProfileDir $dataDir.FullName -CliScript $cliJs -Encoding $utf8NoBom
    Install-ClaudeCoworkPlugin -ProfileDir $dataDir.FullName -RepoRoot $repoRoot -Encoding $utf8NoBom
  }
  foreach ($cfgPath in ($claudeTargets | Select-Object -Unique)) {
    Update-ClaudeDesktopConfig -ConfigPath $cfgPath -NodeExe $nodeExe -CliScript $cliJs -Encoding $utf8NoBom
  }
} else {
  Write-Host '[4/5] Skipping Claude Desktop MCP registration (claude not selected).'
}

Write-Host '[5/5] Verifying flow-canvas CLI...'
node $cliJs version
if ($LASTEXITCODE -ne 0) {
  throw "flow-canvas verification failed with exit code $LASTEXITCODE"
}

Write-Host ''
Write-Host 'Setup complete! On a new PC, run `flow-canvas auth login` once to sign into Google Flow.'
