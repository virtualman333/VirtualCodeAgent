#!/usr/bin/env bash
# ============================================================
# Virtual Code Agent - 打包脚本 (PyInstaller)
#
# 用法:
#   ./build.sh               # 单文件可执行 (默认, dist/vca)
#   ./build.sh --dir         # 目录模式 (dist/vca/ 文件夹, 启动更快)
#   ./build.sh --no-cache    # 不使用缓存构建
#
# 产物:
#   Windows: dist/vca.exe
#   Linux/macOS: dist/vca
# ============================================================

set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="vca"
MODE="onefile"          # onefile | onedir
EXTRA_ARGS=()

# ------------------------------------------------------------
# 解析参数
# ------------------------------------------------------------
for arg in "$@"; do
    case "$arg" in
        --dir)
            MODE="onedir"
            ;;
        --no-cache)
            EXTRA_ARGS+=("--clean")
            ;;
        *)
            echo "未知参数: $arg"
            echo "用法: ./build.sh [--dir] [--no-cache]"
            exit 1
            ;;
    esac
done

# ------------------------------------------------------------
# 检查环境
# ------------------------------------------------------------
if ! command -v python &>/dev/null && ! command -v python3 &>/dev/null; then
    echo "[ERROR] 未找到 Python，请先安装 Python 3.11+"
    exit 1
fi

PYTHON_CMD="python"
if ! command -v python &>/dev/null; then
    PYTHON_CMD="python3"
fi

echo "[1/3] 检查 PyInstaller..."
if ! $PYTHON_CMD -c "import PyInstaller" &>/dev/null; then
    echo "      安装 PyInstaller..."
    $PYTHON_CMD -m pip install --upgrade pip
    $PYTHON_CMD -m pip install pyinstaller
fi

# ------------------------------------------------------------
# 打包
# ------------------------------------------------------------
echo "[2/3] 开始打包 ($MODE)..."

# 收集 langchain 生态的动态导入
COLLECT_ARGS=(
    --collect-all langgraph
    --collect-all langchain_core
    --collect-all langchain_openai
    --collect-all langchain
)

# 可选依赖 (PIL / PyPDF2 在代码中是 try/except 导入, 需显式收集)
HIDDEN_IMPORTS=(
    --hidden-import PIL
    --hidden-import PyPDF2
)

$PYTHON_CMD -m PyInstaller \
    --noconfirm \
    --clean \
    --name "$APP_NAME" \
    --paths src \
    $( [ "$MODE" = "onefile" ] && echo "--onefile" || echo "--onedir" ) \
    "${COLLECT_ARGS[@]}" \
    "${HIDDEN_IMPORTS[@]}" \
    "${EXTRA_ARGS[@]}" \
    run.py

# ------------------------------------------------------------
# 结果
# ------------------------------------------------------------
echo "[3/3] 打包完成!"

# 检测 Windows (Git Bash / MSYS / Cygwin) 以追加 .exe 后缀
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) EXE_SUFFIX=".exe" ;;
    *) EXE_SUFFIX="" ;;
esac

if [ "$MODE" = "onefile" ]; then
    echo ""
    echo "可执行文件: dist/$APP_NAME$EXE_SUFFIX"
    echo ""
    echo "用法示例:"
    echo "  ./dist/$APP_NAME$EXE_SUFFIX"
    echo "  ./dist/$APP_NAME$EXE_SUFFIX /path/to/project"
else
    echo ""
    echo "可执行文件目录: dist/$APP_NAME/"
    echo ""
    echo "用法示例:"
    echo "  ./dist/$APP_NAME/$APP_NAME$EXE_SUFFIX"
    echo "  ./dist/$APP_NAME/$APP_NAME$EXE_SUFFIX /path/to/project"
fi
