param (
    [string]$Mode = "Silent"
)

# Get the script directory (absolute path of the workspace)
$ProjectDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ProjectDir)) {
    $ProjectDir = (Get-Location).Path
}

# Normalize path separators and trim any newlines/whitespace
$ProjectDir = $ProjectDir.ToString().Trim().Replace("/", "\")

Write-Host "Project Directory: $ProjectDir" -ForegroundColor Green

$VbsPath = Join-Path $ProjectDir "run_silent.vbs"
$VbsContent = "Set WshShell = CreateObject(`"WScript.Shell`")`r`nWshShell.CurrentDirectory = `"$ProjectDir`"`r`nWshShell.Run `"cmd /c start_server_silent.bat`", 0, False`r`nSet WshShell = Nothing"

[System.IO.File]::WriteAllText($VbsPath, $VbsContent)
Write-Host "Created silent launcher: $VbsPath" -ForegroundColor Cyan

# 2. Configure Windows Startup folder shortcut
$StartupFolder = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupFolder "StoresDatabaseServer.lnk"

# Clean up existing shortcut if any
if (Test-Path $ShortcutPath) {
    Remove-Item $ShortcutPath -Force -ErrorAction SilentlyContinue
    Write-Host "Removed old startup shortcut." -ForegroundColor Yellow
}

# Create new shortcut
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)

if ($Mode -eq "Silent") {
    $Shortcut.TargetPath = $VbsPath
    $Shortcut.WorkingDirectory = $ProjectDir
    $Shortcut.Description = "Starts the Stores Database Server silently in the background."
    Write-Host "Setting up Silent Background startup..." -ForegroundColor Cyan
} else {
    $Shortcut.TargetPath = Join-Path $ProjectDir "start_server.bat"
    $Shortcut.WorkingDirectory = $ProjectDir
    $Shortcut.Description = "Starts the Stores Database Server in a visible command window."
    Write-Host "Setting up Visible Console startup..." -ForegroundColor Cyan
}

$Shortcut.Save()
Write-Host "Success: Auto-startup shortcut created in Startup folder!" -ForegroundColor Green
Write-Host "Shortcut Path: $ShortcutPath" -ForegroundColor Green
