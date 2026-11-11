$ErrorActionPreference = 'Stop'
$hostKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.vidrush.companion'
$installRoot = Join-Path $env:LOCALAPPDATA 'VidRush'
if (Test-Path -LiteralPath $hostKey) { Remove-Item -LiteralPath $hostKey -Force }
$resolvedRoot = [IO.Path]::GetFullPath($installRoot)
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'VidRush'))
if ($resolvedRoot -ne $expectedRoot -or [IO.Path]::GetFileName($resolvedRoot) -ne 'VidRush') {
    throw 'Refusing to remove an unexpected installation path.'
}
if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
Write-Host 'Removed the local companion and Chrome registration.'
Write-Host 'Downloaded videos were kept. Remove the extension from chrome://extensions separately.'
