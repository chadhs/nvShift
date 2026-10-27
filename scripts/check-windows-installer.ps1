$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $IsWindows) {
    throw 'Run this installer lifecycle check only on a disposable Windows GitHub Actions runner.'
}
$installers = @(Get-ChildItem release/*-win-x64-setup.exe)
if ($installers.Count -ne 1) { throw 'Expected exactly one nvShift Windows installer.' }
$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs/nvshift'
$executable = Join-Path $installDirectory 'nvShift.exe'
$uninstaller = Join-Path $installDirectory 'Uninstall nvShift.exe'
$shortcut = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/nvShift.lnk'
$profile = Join-Path $env:APPDATA 'nvShift'
$sentinel = Join-Path $profile 'installer-test-preferences.txt'
if (Test-Path $installDirectory) { throw 'Refusing to replace an existing installation.' }
function Install-Application {
    $installerProcess = Start-Process -FilePath $installers[0].FullName -ArgumentList '/S' -Wait -PassThru
    if ($installerProcess.ExitCode -ne 0) { throw "Installer exited with $($installerProcess.ExitCode)." }
    foreach ($file in @($executable, $uninstaller, $shortcut)) {
        if (-not (Test-Path $file)) { throw "Installation is missing $file" }
    }
}
try {
    Install-Application
    New-Item -ItemType Directory -Force $profile | Out-Null
    Set-Content -Path $sentinel -Value 'Keep nvShift preferences' -NoNewline
    & node scripts/check-package.mjs win $installDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Installed package verification failed.' }
    $env:NVSHIFT_EXECUTABLE = $executable
    & node scripts/smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Installed application smoke test failed.' }
    Install-Application
    if ((Get-Content $sentinel -Raw) -ne 'Keep nvShift preferences') { throw 'Reinstall changed app data.' }
} finally {
    Remove-Item Env:NVSHIFT_EXECUTABLE -ErrorAction SilentlyContinue
    if (Test-Path $uninstaller) {
        $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
        if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstallProcess.ExitCode)." }
        $deadline = (Get-Date).AddSeconds(30)
        while ((Test-Path $executable) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        if (Test-Path $executable) { throw 'Uninstall left the application executable behind.' }
        if (Test-Path $shortcut) { throw 'Uninstall left the Start menu shortcut behind.' }
        if (-not (Test-Path $sentinel)) { throw 'Uninstall removed app data.' }
        if ((Get-Content $sentinel -Raw) -ne 'Keep nvShift preferences') { throw 'Uninstall changed app data.' }
    }
    Remove-Item $sentinel -ErrorAction SilentlyContinue
}
Write-Output 'nvShift Windows installer passed install, packaged smoke, reinstall, and uninstall with app data preserved.'
