@echo off
rem Startas av Windows-uppgiften "UterumLager U-synk" vid inloggning.
cd /d "%~dp0.."
node tools\sync-u-live.mjs >> "%~dp0sync-u-live.log" 2>&1
