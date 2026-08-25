@echo off
rem ===========================================================================
rem Registrerar live-synken som Windows-uppgift (startar vid inloggning).
rem HOGERKLICKA denna fil och valj "Kor som administrator" — Windows tillater
rem inte att uppgifter registreras utan hojda rattigheter.
rem
rem U: ar en natverksenhet som bara finns i DIN inloggade session, darfor
rem "vid inloggning" och inte som tjanst.
rem ===========================================================================
setlocal
for %%I in ("%~dp0") do set TOOLS=%%~fI
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Kor den har filen som ADMINISTRATOR: hogerklicka - "Kor som administrator".
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$bat = Join-Path '%TOOLS%' 'sync-u-live-bakgrund.bat';" ^
  "$a = New-ScheduledTaskAction -Execute $bat;" ^
  "$t = New-ScheduledTaskTrigger -AtLogOn;" ^
  "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5);" ^
  "Register-ScheduledTask -TaskName 'UterumLager U-synk' -Action $a -Trigger $t -Settings $s -Description 'Speglar aktiverade kunders filer till U:\ live.' -Force | Out-Null;" ^
  "Start-ScheduledTask -TaskName 'UterumLager U-synk';" ^
  "Get-ScheduledTask -TaskName 'UterumLager U-synk' | Select-Object TaskName,State | Format-List"
echo.
echo  Klart. Synken kor nu och startar om vid varje inloggning.
echo  Logg:      %TOOLS%sync-u-live.log
echo  Ta bort:   schtasks /Delete /TN "UterumLager U-synk" /F
echo.
pause
