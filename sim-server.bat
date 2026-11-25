@echo off
rem ============================================================
rem  GlobalSim local sim server - double-click launcher.
rem  Runs race simulations on all CPU cores OUTSIDE the browser
rem  tab (fixes renderer "Out of Memory" on big skill charts).
rem  Keep this window open while the simulator runs.
rem  Advanced: sim-server.bat --lan --token=SECRET --port=NNNN
rem ============================================================
title GlobalSim sim server
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found on PATH.
    echo Install it from https://nodejs.org ^(LTS^), then run this again.
    echo.
    pause
    exit /b 1
)
cd /d "%~dp0"
if not exist "node_modules\ts-node" (
    echo Installing project dependencies - one time, please wait...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo npm install failed. Check the messages above.
        pause
        exit /b 1
    )
)
if /i "%~1"=="--self-test" goto self-test
echo Starting the local sim server. Leave this window open while simulating.
echo To stop: press Ctrl+C in this window, or just close it.
echo.
npx ts-node --transpile-only --compiler-options "{\"moduleResolution\":\"node\",\"module\":\"commonjs\"}" umalator-global\v2\engines\globalsim\sim-server.ts %*
echo.
echo The server has stopped.
pause
goto :eof

:self-test
echo Running the GPU self-test. It writes globalsim-self-test.json here.
echo Share that file with a bug report.
echo.
node tools\gpu-self-test.mjs %2 %3 %4 %5
if errorlevel 1 echo The self-test reported a problem. See globalsim-self-test.json.
echo.
pause
exit /b %errorlevel%

