<#
.SYNOPSIS
  Builds oh-my-openagent from PowerShell.

.DESCRIPTION
  `bun run build` chains several sub-package scripts (lsp-tools-mcp, etc.)
  that use POSIX commands like `rm -rf`. Those aren't available under
  PowerShell/cmd's PATH, only inside Git Bash. This wrapper runs the real
  build (`bun run build` at the repo root) through Git Bash so it works
  the same way from a native PowerShell prompt.

.PARAMETER GitBashPath
  Override the path to bash.exe if Git isn't installed at the default location.

.EXAMPLE
  .\script\agent\build.ps1
#>
param(
  [string]$GitBashPath
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Resolve-GitBash {
  param([string]$Override)

  if ($Override) {
    if (Test-Path $Override) { return $Override }
    throw "GitBashPath '$Override' does not exist."
  }

  $candidates = @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }

  $onPath = Get-Command bash.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  throw "Git Bash not found. Install Git for Windows (https://git-scm.com/download/win) or pass -GitBashPath."
}

$bash = Resolve-GitBash -Override $GitBashPath
Write-Host "[build.ps1] repo: $repoRoot"
Write-Host "[build.ps1] using bash: $bash"

# Convert the Windows path to the POSIX form bash expects (C:\x\y -> /c/x/y).
$posixRoot = "/" + $repoRoot.Substring(0, 1).ToLower() + $repoRoot.Substring(2).Replace('\', '/')

& $bash -lc "cd '$posixRoot' && bun run build"
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  Write-Error "[build.ps1] build failed with exit code $exitCode"
  exit $exitCode
}

Write-Host "[build.ps1] build succeeded -> $repoRoot\dist\index.js"
