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

function Update-ClaudeDesktopConfig {
  param(
    [string]$ConfigPath,
    [string]$NodeExe,
    [string]$CliScript,
    [System.Text.Encoding]$Encoding
  )

  $parentDir = Split-Path -Path $ConfigPath -Parent
  New-Item -ItemType Directory -Path $parentDir -Force | Out-Null

  $configObj = $null
  if (Test-Path $ConfigPath) {
    $raw = Get-Content -Path $ConfigPath -Raw -ErrorAction SilentlyContinue
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
      $configObj = $raw | ConvertFrom-Json
    }
  }
  if ($null -eq $configObj) {
    $configObj = [pscustomobject]@{}
  }

  $existingServers = $configObj.PSObject.Properties['mcpServers']
  if ($null -eq $existingServers -or $null -eq $existingServers.Value) {
    $configObj | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{}) -Force
  }

  $entry = [pscustomobject]@{
    command = $NodeExe
    args    = @($CliScript, 'mcp')
  }
  $configObj.mcpServers | Add-Member -NotePropertyName 'google-flow' -NotePropertyValue $entry -Force

  $jsonText = ($configObj | ConvertTo-Json -Depth 10) + "`n"
  [System.IO.File]::WriteAllText($ConfigPath, $jsonText, $Encoding)
  Write-Host "  Registered google-flow MCP -> $ConfigPath"
}

if ($selectedAgents -contains 'claude') {
  Write-Host '[4/5] Registering google-flow MCP in Claude Desktop configs...'
  $nodeExe = (Get-Command node).Source
  $claudeTargets = @((Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'))
  $msixPackages = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Packages') -Filter 'Claude_*' -Directory -ErrorAction SilentlyContinue
  foreach ($pkg in $msixPackages) {
    $claudeTargets += Join-Path $pkg.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json'
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
