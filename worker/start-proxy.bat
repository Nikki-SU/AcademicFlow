@echo off
rem ============================================================
rem AcademicFlow MinerU 本地代理启动脚本
rem ============================================================
rem 使用方式：
rem   1) 双击：把本文件放在 AcademicFlow\worker\ 下直接双击
rem   2) 开机自启：把本文件复制到 shell:startup 目录，然后
rem      把下面 MY_PROJECT_DIR 改成你的项目绝对路径
rem ============================================================

rem ---- 用户配置：只有开机自启才需要改这里 ----
rem 双击场景留空就行，会自动从 bat 所在位置推断
set MY_PROJECT_DIR=

rem ---- 1) 找 Deno ----
where deno >nul 2>&1
if %errorlevel%==0 (
    set "DENO_CMD=deno"
) else if exist "%USERPROFILE%\.deno\bin\deno.exe" (
    set "DENO_CMD=%USERPROFILE%\.deno\bin\deno.exe"
) else if exist "%LOCALAPPDATA%\deno\bin\deno.exe" (
    set "DENO_CMD=%LOCALAPPDATA%\deno\bin\deno.exe"
) else (
    echo.
    echo   [错误] 找不到 Deno！
    echo   请先安装：https://deno.land/#install
    echo.
    pause
    exit /b 1
)

rem ---- 2) 找项目目录 ----
if defined MY_PROJECT_DIR (
    set "PROJECT_DIR=%MY_PROJECT_DIR%"
) else if exist "%~dp0..\worker\deno.js" (
    rem 双击场景：bat 在 worker\ 下，上级就是项目根
    set "PROJECT_DIR=%~dp0.."
) else (
    echo.
    echo   [错误] 找不到项目目录！
    echo   请编辑本文件，把 MY_PROJECT_DIR 改成你的 AcademicFlow 绝对路径
    echo   例如：set MY_PROJECT_DIR=C:\Users\你\Documents\AcademicFlow
    echo.
    pause
    exit /b 1
)

rem 清理 PROJECT_DIR 尾部反斜杠（防 %\ 歧义）
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

rem ---- 3) 启动 ----
cd /d "%PROJECT_DIR%"
echo.
echo   ==========================================
echo     AcademicFlow MinerU Proxy
echo   ==========================================
echo   项目: %PROJECT_DIR%
echo   Deno: %DENO_CMD%
echo   ==========================================
echo.
"%DENO_CMD%" run --allow-net worker\deno.js
pause
