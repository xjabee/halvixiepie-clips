@echo off
REM ============================================
REM  halvixiepie-clips — one-time repo setup
REM  Run this from inside F:\Repos\halvixiepie-clips
REM  (with server.js and package.json already in it)
REM ============================================

cd /d F:\Repos\halvixiepie-clips || (echo Folder F:\Repos\halvixiepie-clips not found & pause & exit /b 1)

if not exist server.js (
  echo server.js is missing from this folder — copy it in first.
  pause
  exit /b 1
)

set /p GHUSER=Your GitHub username: 

echo node_modules/> .gitignore

git init
git branch -M main
git add .
git commit -m "clips submission form + admin MP4 downloader"
git remote add origin https://github.com/%GHUSER%/halvixiepie-clips.git
git push -u origin main

if errorlevel 1 (
  echo.
  echo Push failed. Make sure you created an EMPTY private repo named
  echo halvixiepie-clips on github.com first ^(no README, no .gitignore^).
) else (
  echo.
  echo Done! Repo is live at https://github.com/%GHUSER%/halvixiepie-clips
  echo Next: Railway ^> + New ^> GitHub Repo ^> halvixiepie-clips
)
pause
