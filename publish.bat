@echo off
setlocal

REM ============================================================
REM VCA - 发布 VS Code 扩展到插件市场 (Windows)
REM
REM 用法:
REM   publish.bat [选项]
REM
REM 选项:
REM   --version <x.y.z>    指定发布版本 (默认自动递增 patch)
REM   --patch / --minor / --major
REM   --skip-build         跳过构建, 直接发布已有产物
REM   --pat <token>        指定 Market PAT (或环境变量 VSCE_PAT)
REM   --ovsx               同时发布到 Open VSX (需要 OVSX_TOKEN)
REM   --ovsx-only          只发布 Open VSX
REM   --dry-run            只构建/改版本, 不真正发布
REM
REM 首次使用 (一次性准备):
REM   1. 注册 publisher: https://marketplace.visualstudio.com/manage
REM      (publisher id 须为 "vca", 或修改 vscode/package.json)
REM   2. 创建 Azure DevOps PAT: https://dev.azure.com
REM      头像 -> Personal Access Tokens -> New Token
REM      Scopes: Marketplace -> Acquire (Manage)
REM   3. set VSCE_PAT=你的token
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] 未找到 Node.js, 请先安装 Node.js 18+ 并加入 PATH
    exit /b 1
)

node scripts\publish.mjs %*
exit /b %errorlevel%
