param([switch]$Check)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
if ($Check) {
    [void][Windows.Forms.FolderBrowserDialog]
    exit 0
}
$dialog = New-Object Windows.Forms.FolderBrowserDialog
try {
    $dialog.Description = 'Choose where VidRush saves your videos'
    $dialog.ShowNewFolderButton = $true
    if ([IO.Directory]::Exists($env:VIDRUSH_CURRENT_FOLDER)) { $dialog.SelectedPath = $env:VIDRUSH_CURRENT_FOLDER }
    if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) {
        @{ cancelled = $false; path = $dialog.SelectedPath } | ConvertTo-Json -Compress
    } else { @{ cancelled = $true } | ConvertTo-Json -Compress }
} finally { $dialog.Dispose() }
