@echo off
rem ============================================================
rem AcademicFlow MinerU 本地代理启动脚本
rem ============================================================
rem 支持任意位置双击：
rem   A. 在 worker\ 下双击（最常见）
rem   B. 在项目根目录双击
rem   C. 复制到 shell:startup 开机自启（需填 MY_PROJECT_DIR）
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

rem ---- 2) 找项目目录（三级 fallback，哪个命中用哪个）----
rem 优先级：MY_PROJECT_DIR > bat 同级 > bat\..\worker 同级
rem 这样无论 bat 在项目根、worker\ 下、还是其他位置，都能找到

rem ---- 2a) 用户手动指定 ----
if defined MY_PROJECT_DIR (
    set "PROJECT_DIR=%MY_PROJECT_DIR%"
    goto :found_project
)

rem ---- 2b) bat 同级目录：检查是否有 worker\deno.js（bat 可能被复制到项目根）----
if exist "%~dp0worker\deno.js" (
    set "PROJECT_DIR=%~dp0"
    goto :found_project
)

rem ---- 2c) bat 上级目录：bat 在 worker\ 下，上级就是项目根 ----
if exist "%~dp0..\worker\deno.js" (
    set "PROJECT_DIR=%~dp0.."
    goto :found_project
)

rem ---- 2d) 还是找不到 ----
echo.
echo   [错误] 找不到项目目录！
echo   脚本会尝试以下位置：
echo     1. MY_PROJECT_DIR 变量（如果已设置）
echo     2. bat 同级目录下的 worker\deno.js
echo     3. bat 上级目录下的 worker\deno.js
echo.
echo   如果以上都找不到，请编辑本文件，把 MY_PROJECT_DIR 改成你的 AcademicFlow 绝对路径
echo   例如：set MY_PROJECT_DIR=C:\Users\你\Documents\AcademicFlow
echo.
echo   当前 bat 位置：%~dp0
echo.
pause
exit /b 1

:found_project
rem 清理 PROJECT_DIR 尾部反斜杠（防 %\ 歧义）
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

rem 最终验证一下 worker\deno.js 确实存在
if not exist "%PROJECT_DIR%\worker\deno.js" (
    echo.
    echo   [错误] 找到项目目录但里面没有 worker\deno.js
    echo   项目目录：%PROJECT_DIR%
    echo   确认项目完整克隆了 AcademicFlow 仓库
    echo.
    pause
    exit /b 1
)

rem ---- 3) 启动 ----
cd /d "%PROJECT_DIR%"
echo.
echo   ==========================================
echo     AcademicFlow MinerU Proxy 启动中...
echo   ==========================================
echo   项目: %PROJECT_DIR%
echo   Deno: %DENO_CMD%
echo   端口: 8000 (本地)
echo   ==========================================
echo.
echo   健康检查: http://localhost:8000/__af_health
echo   在 AcademicFlow 设置里填代理地址: http://localhost:8000
echo.

"%DENO_CMD%" run --allow-net worker\deno.js

echo.
echo   代理已退出（上面是 Deno 的输出）。
echo   如果显示 "Listening on http://0.0.0.0:8000/"，说明启动成功。
echo.
pause
