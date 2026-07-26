@echo off
REM ============================================
REM  halvixiepie-clips — commit + push updates
REM  Double-click any time you change the code.
REM  Railway redeploys automatically on push.
REM ============================================

cd /d F:\Repos\halvixiepie-clips || (echo Folder not found & pause & exit /b 1)

set /p MSG=Commit message (Enter for "update"): 
if "%MSG%"=="" set MSG=update

git add .
git commit -m "%MSG%"
git push

echo.
echo Pushed — Railway is redeploying now.
pause
