@echo off
rem AcademicFlow 本地代理启动脚本
rem 放在 worker/ 目录下，双击即可
rem 依赖：已安装 Deno（deno.land）

cd /d "%~dp0.."
echo ==========================================
echo   AcademicFlow MinerU Proxy
echo ==========================================
echo.
deno run --allow-net worker/deno.js
pause
