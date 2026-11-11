param(
    [switch]$NoOpen,
    [switch]$PrepareOnly,
    [switch]$ForcePortableRuntime
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Join-Path $env:LOCALAPPDATA 'VidRush'
$setupRuntime = Join-Path $installRoot 'setup-runtime'
$stage = $null
$setupLock = New-Object Threading.Mutex($false, 'Local\VidRushSetup')
$ownsLock = $false

function Get-RuntimeInfo([string]$Executable) {
    if (-not $Executable -or -not [IO.File]::Exists($Executable)) { return $null }
    try {
        $result = & $Executable -p 'JSON.stringify({major:parseInt(process.versions.node),arch:process.arch})' 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return ($result | ConvertFrom-Json)
    } catch { return $null }
}

function Get-Sha256([string]$File) {
    if (-not [IO.File]::Exists($File)) { return '' }
    $stream = [IO.File]::OpenRead($File)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
}

function Get-Download([string]$Url, [string]$File) {
    $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source --fail --location --retry 2 --connect-timeout 20 --max-time 900 --output $File $Url
        if ($LASTEXITCODE -ne 0) { throw 'A required download failed. Check your internet connection and run Install.cmd again.' }
    } else {
        $client = New-Object Net.WebClient
        try { $client.DownloadFile($Url, $File) } finally { $client.Dispose() }
    }
}

try {
    $ownsLock = $setupLock.WaitOne(0)
    if (-not $ownsLock) { throw 'VidRush setup is already running. Use the other setup window.' }
    Write-Host ''
    Write-Host 'VidRush setup' -ForegroundColor Cyan
    Write-Host 'No programming tools or administrator access are needed.'
    Write-Host ''
    Write-Host '[1/3] Preparing the local runtime ...'

    $processor = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $architecture = switch ($processor.ToUpperInvariant()) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        default { throw 'VidRush requires 64-bit Windows (x64 or ARM64).' }
    }
    $node = $null
    if (-not $ForcePortableRuntime) {
        $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
        $candidates = @((Join-Path $setupRuntime 'node.exe'))
        if ($command) { $candidates += $command.Source }
        foreach ($candidate in $candidates) {
            $info = Get-RuntimeInfo $candidate
            if ($info -and $info.major -ge 22 -and $info.arch -eq $architecture) { $node = $candidate; break }
        }
    }

    if (-not $node) {
        Write-Host 'Downloading a private Node.js LTS runtime from nodejs.org.'
        Write-Host 'This does not change your system PATH or install Node.js globally.'
        $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
        $release = $releases | Where-Object {
            $_.lts -and $_.version -match '^v(\d+)\.\d+\.\d+$' -and
            [int]$Matches[1] -ge 22 -and $_.files -contains "win-$architecture-zip"
        } | Select-Object -First 1
        if (-not $release) { throw 'No supported Node.js LTS Windows release was found. Retry setup later.' }
        $version = $release.version
        $filename = "node-$version-win-$architecture.zip"
        $releaseUrl = "https://nodejs.org/dist/$version"
        $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/SHASUMS256.txt" -TimeoutSec 60).Content
        $line = ($sums -split "`n" | Where-Object { $_ -match ('^([a-fA-F0-9]{64})\s+\*?' + [Regex]::Escape($filename) + '\s*$') } | Select-Object -First 1)
        if (-not $line) { throw 'The Node.js release is missing its SHA-256 checksum. Retry setup later.' }
        $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
        $cacheRoot = Join-Path $installRoot 'cache'
        [void][IO.Directory]::CreateDirectory($cacheRoot)
        $archive = Join-Path $cacheRoot "$expected-$filename"
        if ((Get-Sha256 $archive) -ne $expected) {
            Get-Download "$releaseUrl/$filename" $archive
            if ((Get-Sha256 $archive) -ne $expected) { throw 'Node.js checksum verification failed. Run Install.cmd again; the file will not be used.' }
        } else { Write-Host 'Using the verified cached Node.js download.' }
        Write-Host 'Node.js SHA-256 verified.'
        $stage = Join-Path ([IO.Path]::GetTempPath()) ('vidrush-bootstrap-' + [Guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($stage)
        [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
        [IO.Compression.ZipFile]::ExtractToDirectory($archive, $stage)
        [void][IO.Directory]::CreateDirectory($setupRuntime)
        $extracted = Join-Path $stage "node-$version-win-$architecture"
        Copy-Item -LiteralPath (Join-Path $extracted 'node.exe') -Destination (Join-Path $setupRuntime 'node.exe') -Force
        Copy-Item -LiteralPath (Join-Path $extracted 'LICENSE') -Destination (Join-Path $setupRuntime 'LICENSE') -Force
        $node = Join-Path $setupRuntime 'node.exe'
    }

    $info = Get-RuntimeInfo $node
    if (-not $info -or $info.major -lt 22 -or $info.arch -ne $architecture) { throw 'The local runtime could not start. Run Install.cmd again.' }
    Write-Host "Prepared runtime: $node"
    if (-not $PrepareOnly) {
        Write-Host ''
        Write-Host '[2/3] Installing yt-dlp, FFmpeg, and the Chrome companion ...'
        $arguments = @((Join-Path $PSScriptRoot 'install.cjs'))
        if ($NoOpen) { $arguments += '--no-open' }
        & $node @arguments
        if ($LASTEXITCODE -ne 0) { throw 'Setup did not complete. Read the error above and run Install.cmd again.' }
        Write-Host ''
        Write-Host '[3/3] Ready. Follow the final Chrome activation steps in the setup guide.' -ForegroundColor Green
    }
} catch {
    Write-Host ''
    Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($stage -and [IO.Directory]::Exists($stage)) {
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        if ([IO.Path]::GetDirectoryName($resolvedStage) -eq $tempRoot -and [IO.Path]::GetFileName($resolvedStage).StartsWith('vidrush-bootstrap-')) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
    if ($ownsLock) { $setupLock.ReleaseMutex() }
    $setupLock.Dispose()
}
