param([switch]$Check)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
if ($Check) {
    [void][Windows.Forms.FolderBrowserDialog]
    exit 0
}
$dialog = New-Object Windows.Forms.FolderBrowserDialog
$owner = New-Object Windows.Forms.Form
try {
    $dialog.Description = 'Choose where VidRush saves your videos'
    $dialog.ShowNewFolderButton = $true
    if ([IO.Directory]::Exists($env:VIDRUSH_CURRENT_FOLDER)) { $dialog.SelectedPath = $env:VIDRUSH_CURRENT_FOLDER }
    $owner.Text = 'VidRush - Download folder'
    $owner.ShowInTaskbar = $false
    $owner.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
    $owner.TopMost = $true
    $owner.Opacity = 0
    $owner.Show()
    if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) {
        @{ cancelled = $false; path = $dialog.SelectedPath } | ConvertTo-Json -Compress
    } else { @{ cancelled = $true } | ConvertTo-Json -Compress }
} finally { $dialog.Dispose(); $owner.Dispose() }
