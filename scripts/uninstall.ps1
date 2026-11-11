$ErrorActionPreference = 'Stop'
$hostKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.vidrush.companion'
$installRoot = Join-Path $env:LOCALAPPDATA 'VidRush'
$resolvedRoot = [IO.Path]::GetFullPath($installRoot)
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'VidRush'))
if ($resolvedRoot -ne $expectedRoot -or [IO.Path]::GetFileName($resolvedRoot) -ne 'VidRush') {
    throw 'Refusing to remove an unexpected installation path.'
}
if (Test-Path -LiteralPath $resolvedRoot) {
    $installItem = Get-Item -LiteralPath $resolvedRoot -Force
    if (($installItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The installation folder is a link. Remove it manually after preserving your files.'
    }
    $configFile = Join-Path $resolvedRoot 'config.json'
    if (Test-Path -LiteralPath $configFile) {
        $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
        $downloadRoot = [IO.Path]::GetFullPath($config.downloadDir).TrimEnd('\')
        if ($downloadRoot.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
            $downloadRoot.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Your download folder is inside the installation folder. Move those videos elsewhere and update config.json before uninstalling.'
        }
    }
}
if (Test-Path -LiteralPath $hostKey) { Remove-Item -LiteralPath $hostKey -Force }
if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
Write-Host 'Removed the local companion and Chrome registration.'
Write-Host 'Downloaded videos were kept. Remove the extension from chrome://extensions separately.'
