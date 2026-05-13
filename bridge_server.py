"""兼容保留入口：请使用 bridge_server.js 作为主实现。"""

from pathlib import Path

if __name__ == "__main__":
    print(Path(__file__).name + " is deprecated; use bridge_server.js")
