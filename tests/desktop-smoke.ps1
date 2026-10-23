$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, WindowsBase
$script:smokeStage = 0
$script:smokeFailure = ''
$script:smokeStarted = Get-Date
$script:smokeTimer = [Windows.Threading.DispatcherTimer]::new()
$smokeTimer.Interval = [timespan]::FromMilliseconds(200)
$smokeTimer.Add_Tick({
    try {
        if (((Get-Date) - $smokeStarted).TotalSeconds -gt 18) { throw "Native UI timeout at stage $smokeStage : $($controls.Feedback.Text)" }
        switch ($smokeStage) {
            0 {
                if ($script:ready -and $controls.StartButton.IsEnabled -and $settings -and $controls.SavePersonaButton.IsEnabled) {
                    $inputs['identity.name'].Control.Text = 'Native desktop test'
                    if (!$settingsDirty) { throw 'Settings dirty tracking failed' }
                    $controls.SaveSettingsButton.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
                    $script:smokeStage = 1
                }
            }
            1 {
                if (!$settingsDirty -and $controls.SaveSettingsButton.IsEnabled) {
                    if ($settings.identity.name -ne 'Native desktop test') { throw 'Settings save failed' }
                    $controls.Navigation.SelectedIndex = 2
                    if ($controls.PersonaPage.Visibility -ne 'Visible') { throw 'Native navigation failed' }
                    $controls.PersonaText.Text = 'Native persona test'
                    $controls.SavePersonaButton.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
                    $script:smokeStage = 2
                }
            }
            2 {
                if (!$personaDirty -and $controls.SavePersonaButton.IsEnabled) {
                    $controls.Navigation.SelectedIndex = 3
                    $script:smokeStage = 3
                }
            }
            3 {
                if ($controls.SessionList.Children.Count -gt 0) {
                    $controls.Navigation.SelectedIndex = 4
                    $script:lastPoll = [datetime]::MinValue
                    $script:smokeStage = 4
                }
            }
            4 {
                if ($controls.LogText.Text.Length -gt 0) {
                    $controls.LogSearch.Text = 'no-match-for-native-desktop-test'
                    if ($controls.LogText.Text.Length) { throw 'Log filtering failed' }
                    $controls.LogSearch.Text = ''
                    $controls.PauseLogsButton.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
                    if (!$paused) { throw 'Log pause failed' }
                    $controls.PauseLogsButton.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
                    $script:smokeStage = 5
                    $smokeTimer.Stop()
                    $window.Close()
                }
            }
        }
    } catch {
        $script:smokeFailure = $_.Exception.Message
        $smokeTimer.Stop()
        $script:settingsDirty = $false; $script:personaDirty = $false
        $window.Close()
    }
})
$smokeTimer.Start()
. (Join-Path $PSScriptRoot '../desktop/start.ps1') -TestMode
$smokeTimer.Stop()
if ($smokeFailure) { Write-Error $smokeFailure; exit 1 }
if ($smokeStage -ne 5) { Write-Error "Native UI exited at stage $smokeStage"; exit 1 }
Write-Output 'Native UI smoke passed: async status, settings, persona, navigation, sessions, logs, close.'
