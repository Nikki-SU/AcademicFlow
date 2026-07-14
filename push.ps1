param(
    [string]$CommitMessage = "Auto push: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Continue"
$originalErrorAction = $ErrorActionPreference

function Write-Status {
    param([string]$Message, [string]$Type = "info")
    $color = switch ($Type) {
        "success" { [ConsoleColor]::Green }
        "error" { [ConsoleColor]::Red }
        "warning" { [ConsoleColor]::Yellow }
        default { [ConsoleColor]::Cyan }
    }
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')]" -ForegroundColor Gray -NoNewline
    Write-Host " $Message" -ForegroundColor $color
}

function Run-Git {
    param([string]$Command)
    $ErrorActionPreference = "SilentlyContinue"
    & git --no-pager $Command.Split() 2>&1 | ForEach-Object { "$_" }
    $result = $LASTEXITCODE
    $ErrorActionPreference = $originalErrorAction
    return $result
}

function Get-GitOutput {
    param([string]$Command)
    $ErrorActionPreference = "SilentlyContinue"
    $output = & git --no-pager $Command.Split() 2>&1 | ForEach-Object { "$_" }
    $ErrorActionPreference = $originalErrorAction
    return $output
}

Write-Status "=== AcademicFlow Auto Push ==="
Write-Status "Commit message: $CommitMessage"
Write-Status "Target branch: $Branch"
Write-Status ""

if (-not (Test-Path ".git")) {
    Write-Status "ERROR: Not a Git repository" "error"
    exit 1
}

Write-Status "Configuring git..."
Run-Git "config --local credential.helper manager" | Out-Null

$userName = Get-GitOutput "config --get user.name"
$userEmail = Get-GitOutput "config --get user.email"
if (-not $userName -or -not $userEmail) {
    Write-Status "Setting git user info..." "warning"
    Run-Git "config --local user.name `"AcademicFlow`"" | Out-Null
    Run-Git "config --local user.email `"academicflow@local`"" | Out-Null
}

$currentBranch = Get-GitOutput "rev-parse --abbrev-ref HEAD"
if ($LASTEXITCODE -ne 0) {
    Write-Status "ERROR: Failed to get current branch" "error"
    exit 1
}
$currentBranch = $currentBranch.Trim()
Write-Status "Current branch: $currentBranch"

if ($currentBranch -ne $Branch) {
    Write-Status "Switching to branch: $Branch"
    Run-Git "checkout $Branch" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Status "ERROR: Failed to switch branch" "error"
        exit 1
    }
}

Write-Status "Syncing remote branch..."
Run-Git "fetch origin $Branch" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Status "ERROR: Fetch failed, check network" "error"
    exit 1
}
Run-Git "merge --ff-only origin/$Branch" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Status "ERROR: Branch behind or conflicts, resolve manually" "error"
    exit 1
}
Write-Status "Local branch synced" "success"

$status = Get-GitOutput "status --porcelain"
if ($LASTEXITCODE -ne 0) {
    Write-Status "ERROR: Failed to get git status" "error"
    exit 1
}

if (-not $status) {
    Write-Status "No changes to commit" "warning"
    exit 0
}

Write-Status "Changes detected, committing..."
Run-Git "add -A" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Status "ERROR: git add failed" "error"
    exit 1
}

$commitOutput = Get-GitOutput "commit -m `"$CommitMessage`""
if ($LASTEXITCODE -ne 0) {
    Write-Status "ERROR: git commit failed" "error"
    Write-Status "Commit output:" "warning"
    Write-Host $commitOutput
    exit 1
}
Write-Status "Commit successful: $commitOutput" "success"

Write-Status "Pushing to remote..."

if ($env:GITHUB_TOKEN) {
    Write-Status "Using token from environment variable" "info"
    $remoteUrl = Get-GitOutput "config --get remote.origin.url"
    if ($remoteUrl -match 'https://') {
        $user = $remoteUrl -replace 'https://([^/]+)/.*', '$1'
        $repo = $remoteUrl -replace 'https://[^/]+/(.*)', '$1'
        $authUrl = "https://$user`:$($env:GITHUB_TOKEN)@github.com/$repo"
        Run-Git "push $authUrl $Branch" | Out-Null
    } else {
        Write-Status "WARNING: Remote URL is not HTTPS, falling back to default" "warning"
        Run-Git "push origin $Branch" | Out-Null
    }
} else {
    Write-Status "NOTE: If prompted, enter your GitHub PAT (Personal Access Token)" "warning"
    Run-Git "push origin $Branch" | Out-Null
}

if ($LASTEXITCODE -eq 0) {
    Write-Status "SUCCESS: Push completed!" "success"
    Write-Status ""
    Write-Status "GitHub Actions will deploy to Pages automatically" "success"
} else {
    Write-Status "ERROR: Push failed" "error"
    Write-Status ""
    Write-Status "Possible causes:" "warning"
    Write-Status "1. Network connection issues" "warning"
    Write-Status "2. Invalid credentials" "warning"
    Write-Status "3. Remote branch has newer commits" "warning"
    Write-Status ""
    Write-Status "Try running: git push origin $Branch manually" "warning"
    exit 1
}