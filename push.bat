@echo off
REM ============================================
REM  halvixiepie-clips — commit + push updates
REM  Double-click any time you change the code.
REM  Railway redeploys automatically on push.
REM ============================================

cd /d F:\Repos\halvixiepie-clips || (echo Folder not found & pause & exit /b 1)

echo ---- What git sees as changed: ----
git status --short
echo -----------------------------------
git diff --quiet && git diff --cached --quiet && (
  echo.
  echo NOTHING CHANGED — the files in this folder are identical to the
  echo last push. If you downloaded a new server.js, it did NOT land here.
  echo Run this in PowerShell to pull it in from Downloads:
  echo.
  echo Get-ChildItem "$env:USERPROFILE\Downloads\server*.js" ^| Sort-Object LastWriteTime -Descending ^| Select-Object -First 1 ^| Copy-Item -Destination "F:\Repos\halvixiepie-clips\server.js" -Force
  echo.
  pause
  exit /b 0
)

set /p MSG=Commit message (Enter for "update"): 
if "%MSG%"=="" set MSG=update

git add .
git commit -m "%MSG%"
git push
if errorlevel 1 (
  echo.
  echo PUSH FAILED — read the error above. Common causes:
  echo  - not logged in: run  gh auth login
  echo  - no remote: run  git remote -v  to check
) else (
  echo.
  echo Pushed — Railway is redeploying now.
)
pause
