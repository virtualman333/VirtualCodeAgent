@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM VCA - 构建 VSIX 扩展包脚本 (Windows)
REM
REM 用法:
REM   build-vsix.bat            完整构建并打包 VSIX
REM   build-vsix.bat --skip-web 跳过前端构建 (复用 web/dist)
REM   build-vsix.bat --skip-ext 跳过扩展构建 (复用 vscode/dist)
REM
REM 产物:
REM   vscode\vca-coding-agent-<version>.vsix
REM ============================================================

cd /d "%~dp0"

set "SKIP_WEB="
set "SKIP_EXT="

REM ------------------------------------------------------------
REM 解析参数
REM ------------------------------------------------------------
for %%A in (%*) do (
    if "%%A"=="--skip-web" (
        set "SKIP_WEB=1"
    ) else if "%%A"=="--skip-ext" (
        set "SKIP_EXT=1"
    ) else (
        echo [ERROR] 未知参数: %%A
        echo 用法: build-vsix.bat [--skip-web] [--skip-ext]
        exit /b 1
    )
)

REM ------------------------------------------------------------
REM 检查 Node.js
REM ------------------------------------------------------------
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] 未找到 Node.js，请先安装 Node.js 18+ 并加入 PATH
    exit /b 1
)
node --version

REM ------------------------------------------------------------
REM 检查 npm / npx
REM ------------------------------------------------------------
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] 未找到 npm
    exit /b 1
)
where npx >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] 未找到 npx
    exit /b 1
)

REM ------------------------------------------------------------
REM Step 1: 构建前端 (Vue → web/dist)
REM ------------------------------------------------------------
if defined SKIP_WEB (
    echo [1/3] 跳过前端构建 (--skip-web)
) else (
    echo [1/3] 构建前端...
    pushd web
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] 前端依赖安装失败
        popd
        exit /b 1
    )
    call npm run build
    if %errorlevel% neq 0 (
        echo [ERROR] 前端构建失败
        popd
        exit /b 1
    )
    popd
)

if not exist "web\dist\index.html" (
    echo [ERROR] 未找到 web\dist\index.html，请先构建前端
    exit /b 1
)

REM ------------------------------------------------------------
REM Step 2: 构建扩展 (esbuild bundle + 复制前端)
REM ------------------------------------------------------------
if defined SKIP_EXT (
    echo [2/3] 跳过扩展构建 (--skip-ext)
) else (
    echo [2/3] 构建扩展...
    call node scripts\build-extension.mjs
    if %errorlevel% neq 0 (
        echo [ERROR] 扩展构建失败
        exit /b 1
    )
)

if not exist "vscode\dist\extension.js" (
    echo [ERROR] 未找到 vscode\dist\extension.js，请先构建扩展
    exit /b 1
)

REM ------------------------------------------------------------
REM Step 3: 打包 VSIX
REM ------------------------------------------------------------
echo [3/3] 打包 VSIX...
pushd vscode
call npx vsce package --allow-missing-repository --no-dependencies
if %errorlevel% neq 0 (
    echo [ERROR] VSIX 打包失败
    popd
    exit /b 1
)
popd

REM ------------------------------------------------------------
REM 结果
REM ------------------------------------------------------------
echo.
echo ============================================================
for %%F in (vscode\*.vsix) do (
    echo VSIX 产物: %%F
)
echo ============================================================
echo.
echo 安装方式: VS Code 扩展面板 → 右上角 ⋯ → 从 VSIX 安装
echo.

exit /b 0
