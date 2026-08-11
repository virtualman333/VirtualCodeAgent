@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM Virtual Code Agent - 打包脚本 (PyInstaller) - Windows
REM
REM 用法:
REM   build.bat              单文件可执行 (默认, dist\vca.exe)
REM   build.bat --dir        目录模式 (dist\vca\ 文件夹, 启动更快)
REM   build.bat --no-cache   不使用缓存构建
REM
REM 产物:
REM   dist\vca.exe  (单文件)
REM   dist\vca\     (目录模式)
REM ============================================================

cd /d "%~dp0"

set "APP_NAME=vca"
set "MODE=onefile"
set "EXTRA_ARGS="

REM ------------------------------------------------------------
REM 解析参数
REM ------------------------------------------------------------
for %%A in (%*) do (
    if "%%A"=="--dir" (
        set "MODE=onedir"
    ) else if "%%A"=="--no-cache" (
        set "EXTRA_ARGS=--clean"
    ) else (
        echo [ERROR] 未知参数: %%A
        echo 用法: build.bat [--dir] [--no-cache]
        exit /b 1
    )
)

REM ------------------------------------------------------------
REM 检查 Python
REM ------------------------------------------------------------
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] 未找到 Python，请先安装 Python 3.11+ 并加入 PATH
    exit /b 1
)

echo [1/3] 检查 PyInstaller...
python -c "import PyInstaller" >nul 2>nul
if %errorlevel% neq 0 (
    echo       正在安装 PyInstaller...
    python -m pip install --upgrade pip
    python -m pip install pyinstaller
)

REM ------------------------------------------------------------
REM 打包
REM ------------------------------------------------------------
echo [2/3] 开始打包 (%MODE%)...

set "COLLECT_ARGS=--collect-all langgraph --collect-all langchain_core --collect-all langchain_openai --collect-all langchain"
set "HIDDEN_IMPORTS=--hidden-import PIL --hidden-import PyPDF2"

set "MODE_FLAG=--onefile"
if "%MODE%"=="onedir" set "MODE_FLAG=--onedir"

python -m PyInstaller ^
    --noconfirm ^
    --clean ^
    --name "%APP_NAME%" ^
    --paths src ^
    %MODE_FLAG% ^
    %COLLECT_ARGS% ^
    %HIDDEN_IMPORTS% ^
    %EXTRA_ARGS% ^
    run.py

if %errorlevel% neq 0 (
    echo [ERROR] 打包失败!
    exit /b 1
)

REM ------------------------------------------------------------
REM 结果
REM ------------------------------------------------------------
echo [3/3] 打包完成!

if "%MODE%"=="onefile" (
    echo.
    echo 可执行文件: dist\%APP_NAME%.exe
    echo.
    echo 用法示例:
    echo   dist\%APP_NAME%.exe
    echo   dist\%APP_NAME%.exe D:\path\to\project
) else (
    echo.
    echo 可执行文件: dist\%APP_NAME%\%APP_NAME%.exe
    echo.
    echo 用法示例:
    echo   dist\%APP_NAME%\%APP_NAME%.exe
    echo   dist\%APP_NAME%\%APP_NAME%.exe D:\path\to\project
)

exit /b 0
