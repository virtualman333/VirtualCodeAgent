@echo off
REM ============================================================
REM VCA - 构建并打包 VSIX（Windows 包装）
REM
REM 真正的构建链在 scripts\build-vsix.mjs 里 —— 跨平台、可单测、
REM 打包前会预检扩展入口在不在。
REM
REM 这里**只做转发，不要再往这个文件里加逻辑**：一旦两份实现并存，
REM 改了一处忘了另一处，就是「同一件事写了两遍」。
REM
REM 用法:
REM   build-vsix.bat            完整构建并打包 VSIX
REM   build-vsix.bat --skip-web 跳过前端构建 (复用 web/dist)
REM   build-vsix.bat --skip-ext 跳过扩展构建 (复用 vscode/dist)
REM   build-vsix.bat --help     查看全部参数
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] 未找到 Node.js，请先安装 Node.js 18+ 并加入 PATH
    exit /b 1
)

node "%~dp0scripts\build-vsix.mjs" %*
exit /b %errorlevel%
