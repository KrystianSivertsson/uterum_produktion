@echo off
rem Live-synk av U:\<kund>\ mot UterumLager. Lamna fonstret oppet.
cd /d "%~dp0.."
node tools\sync-u-live.mjs
pause
