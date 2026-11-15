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
  Write-Host '[1/4] Installing Node dependencies...'
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
  Write-Host '[1/4] Skipping npm install (-SkipNpm and node_modules already present).'
}

Write-Host '[2/4] Writing CLI shims in $HOME\bin and checking user PATH...'
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

Write-Host '[3/4] Installing bundled skills for selected agents...'
$agentRoots = @{
  antigravity = Join-Path $HOME '.gemini\config\skills'
  kiro        = Join-Path $HOME '.kiro\skills'
  claude      = Join-Path $HOME '.claude\skills'
}

$skillSourceRoot = Join-Path $repoRoot 'skills'
$skillDirs = Get-ChildItem -Path $skillSourceRoot -Directory

$parsedAgents = $Agents | ForEach-Object { $_ -split ',' } | Where-Object { $_ -and $_.Trim() -ne '' }
foreach ($rawAgent in $parsedAgents) {
  $agentKey = $rawAgent.Trim().ToLowerInvariant()
  if (-not $agentRoots.ContainsKey($agentKey)) {
    throw "Unknown agent target '$rawAgent'. Supported values: antigravity, kiro, claude."
  }
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

Write-Host '[4/4] Verifying flow-canvas CLI...'
node $cliJs version
if ($LASTEXITCODE -ne 0) {
  throw "flow-canvas verification failed with exit code $LASTEXITCODE"
}

Write-Host ''
Write-Host 'Setup complete! On a new PC, run `flow-canvas auth login` once to sign into Google Flow.'
