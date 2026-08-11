"""应用入口"""

import sys
import os

# 确保 src 在 path 中
src_dir = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, src_dir)

from vca.main import main

if __name__ == "__main__":
    main()
