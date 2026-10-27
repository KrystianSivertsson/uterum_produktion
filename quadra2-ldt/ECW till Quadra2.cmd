@echo off
rem Dra en eller flera .ECW-filer till den här filen. Programmen (.ldt) och rapport.txt hamnar i en mapp
rem "quadra2_<order>" bredvid ECW-filen. Öppna dem i CAMplus, simulera (Piece > Simulate) och kompilera (Compile LDA).
chcp 65001 >nul
if "%~1"=="" (
  echo Dra en ECW-fil till den har filen.
  pause
  exit /b 1
)
:next
if "%~1"=="" goto done
echo === %~nx1
python "%~dp0ecw2ldt.py" "%~1"
echo.
shift
goto next
:done
pause
