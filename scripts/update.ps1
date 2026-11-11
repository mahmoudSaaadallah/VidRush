param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'VidRush'))
$lock = New-Object Threading.Mutex($false, 'Local\VidRushSetup')
$ownsLock = $false
try {
    $ownsLock = $lock.WaitOne(0)
    if (-not $ownsLock) { throw 'Another VidRush setup or update is already running.' }
    $configFile = Join-Path $installRoot 'config.json'
    if (-not [IO.File]::Exists($configFile)) { throw 'VidRush is not installed. Run Install.cmd first.' }
    $config = [IO.File]::ReadAllText($configFile) | ConvertFrom-Json
    $manifest = [IO.File]::ReadAllText((Join-Path $projectRoot 'extension\manifest.json')) | ConvertFrom-Json
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash([Convert]::FromBase64String($manifest.key)) } finally { $sha.Dispose() }
    $extensionId = -join (0..15 | ForEach-Object { [char](97 + ($bytes[$_] -shr 4)); [char](97 + ($bytes[$_] -band 15)) })
    if ($extensionId -ne $config.extensionId) { throw 'The installed extension ID differs from this project. Run Install.cmd instead.' }
    foreach ($directory in @('host', 'extension')) {
        $sourceRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $directory)).TrimEnd('\')
        foreach ($file in (Get-ChildItem -LiteralPath $sourceRoot -Recurse -File)) {
            if ($file.Extension -notin @('.cjs', '.ps1', '.js', '.json', '.html', '.css', '.png')) { continue }
            $relative = $file.FullName.Substring($sourceRoot.Length + 1)
            $target = [IO.Path]::GetFullPath((Join-Path (Join-Path $installRoot $directory) $relative))
            if (-not $target.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected update path.' }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            $temporary = $target + '.' + [Guid]::NewGuid().ToString('N') + '.update'
            try {
                [IO.File]::Copy($file.FullName, $temporary, $false)
                if ([IO.File]::Exists($target)) { [IO.File]::Replace($temporary, $target, [NullString]::Value) }
                else { [IO.File]::Move($temporary, $target) }
            } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
        }
    }
    Write-Host 'Updated the extension and companion files successfully.' -ForegroundColor Green
    Write-Host 'Your videos, save folder, tools, and running downloads were not changed.'
    Write-Host ''
    Write-Host 'NEXT: Wait for any active downloads to finish, then open chrome://extensions and click Reload on VidRush.'
    Write-Host 'The running companion uses its old code until you reload the extension.'
    if (-not $NoOpen) {
        $locations = @($env:PROGRAMFILES, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)
        $chrome = $locations | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Google\Chrome\Application\chrome.exe' } | Where-Object { [IO.File]::Exists($_) } | Select-Object -First 1
        if ($chrome) { Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions/' -WindowStyle Normal }
    }
} catch { Write-Host "Update failed: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
finally { if ($ownsLock) { $lock.ReleaseMutex() }; $lock.Dispose() }
