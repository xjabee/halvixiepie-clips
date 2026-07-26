@echo off
REM =====================================================
REM  halvixiepie-clips — one-time setup
REM  Creates the GitHub repo AND pushes, all in one go.
REM  Uses GitHub CLI (gh); offers to install it if missing.
REM =====================================================

cd /d F:\Repos\halvixiepie-clips || (echo Folder F:\Repos\halvixiepie-clips not found & pause & exit /b 1)

if not exist server.js (
  echo server.js is missing from this folder — copy it in first.
  pause
  exit /b 1
)

REM ---- make sure GitHub CLI is available ----
where gh >nul 2>&1
if errorlevel 1 (
  echo GitHub CLI ^(gh^) is not installed. It's what lets this script
  echo create the repo on GitHub for you.
  echo.
  set /p INSTALL=Install it now with winget? (y/n): 
  if /i not "%INSTALL%"=="y" (
    echo Skipped. Install it later with:  winget install GitHub.cli
    pause
    exit /b 1
  )
  winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
  echo.
  echo Installed! Close this window and run setup-repo.bat AGAIN —
  echo a fresh window is needed so Windows can find the gh command.
  pause
  exit /b 0
)

REM ---- make sure gh is logged in to your GitHub account ----
gh auth status >nul 2>&1
if errorlevel 1 (
  echo You're not logged in to GitHub yet. A browser login will open —
  echo pick "GitHub.com", "HTTPS", and "Login with a web browser".
  gh auth login
  if errorlevel 1 (echo Login failed or cancelled. & pause & exit /b 1)
)

REM ---- local repo ----
echo node_modules/> .gitignore
if not exist .git git init
git branch -M main
git add .
git commit -m "clips submission form + admin MP4 downloader"

REM ---- create repo on GitHub + push (or just push if it already exists) ----
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  gh repo create halvixiepie-clips --private --source . --push
) else (
  git push -u origin main
)

if errorlevel 1 (
  echo.
  echo Something failed above — read the message it printed.
  echo Most common fix: a repo named halvixiepie-clips already exists
  echo on your account. Delete it on github.com or push manually.
) else (
  echo.
  echo Done! Private repo halvixiepie-clips is live on your GitHub.
  echo Next: Railway ^> + New ^> GitHub Repo ^> halvixiepie-clips,
  echo attach a /data volume, set ADMIN_PASSWORD, add the clips CNAME.
)
pause
