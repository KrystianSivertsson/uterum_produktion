@echo off
REM Speglar aktiverade kunders filer till U:\<kundnamn>\
REM Dubbelklicka for att synka nu. Lagg till i Schemalaggaren for automatik.
cd /d "%~dp0.."
node tools\sync-u.mjs %*
if errorlevel 1 pause
