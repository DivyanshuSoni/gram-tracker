@echo off
rem Builds the signed Gram Tracker APK. Tools live in "D:\Android creation Stuff".
setlocal
set "TOOLS=D:\Android creation Stuff"
set "HERE=%~dp0"
set "JAVA_HOME=%TOOLS%\jdk-17"
set "ANDROID_HOME=%TOOLS%\sdk"
set "ANDROID_USER_HOME=%TOOLS%\android-user-home"
set "GRADLE_USER_HOME=%TOOLS%\gradle-home"
rem Java on Windows opens a local socket in the temp folder; keep that on D: as well
if not exist "%TOOLS%\tmp" mkdir "%TOOLS%\tmp"
set "TMP=%TOOLS%\tmp"
set "TEMP=%TOOLS%\tmp"
call "%TOOLS%\gradle-8.7\bin\gradle.bat" --no-daemon -q -p "%HERE%." assembleRelease
if errorlevel 1 exit /b 1
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content -LiteralPath '%HERE%..\app\version.json' -Raw | ConvertFrom-Json).version"`) do set "VER=%%v"
copy /y "%HERE%app\build\outputs\apk\release\app-release.apk" "%HERE%..\GramTracker-%VER%.apk" >nul
echo Built GramTracker-%VER%.apk
