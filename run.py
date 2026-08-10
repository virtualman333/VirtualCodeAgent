"""运行 Virtual Code Agent"""

import sys
import os

# 确保 src 在 Python path 中
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from vca.main import main

if __name__ == "__main__":
    main()
