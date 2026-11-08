#!/usr/bin/env python3
# 常驻运行：每秒把本脚本所在目录下的 .vite 同步到目标 .vite 目录（跳过 index.pre.js）
# 只在内容变化时复制；目标 .vite 中多出来的文件不删除，但已废弃的 global_execute.js 会被清理
# 用法：python3 sync_vite.py [目标 .vite 目录]，默认 /Applications/Claude.app/Contents/Resources/app/.vite
import os
import shutil
import sys
import time

INTERVAL = 1.0
SKIP = {"index.pre.js"}
# 源目录已删除的废弃脚本，同步时从目标目录一并删除
STALE_RELS = {"build/global_execute.js"}
DEFAULT_DST = "/Applications/Claude.app/Contents/Resources/app/.vite"


def same_content(a, b):
    if os.path.getsize(a) != os.path.getsize(b):
        return False
    with open(a, "rb") as fa, open(b, "rb") as fb:
        while True:
            ca = fa.read(1 << 20)
            cb = fb.read(1 << 20)
            if ca != cb:
                return False
            if not ca:
                return True


def sync_once(src_root, dst_root):
    for rel in STALE_RELS:
        src = os.path.join(src_root, rel)
        dst = os.path.join(dst_root, rel)
        if os.path.exists(dst) and not os.path.exists(src):
            os.remove(dst)
            print(f"removed stale {rel}", flush=True)
    for root, _dirs, files in os.walk(src_root):
        for name in files:
            if name in SKIP:
                continue
            src = os.path.join(root, name)
            rel = os.path.relpath(src, src_root)
            dst = os.path.join(dst_root, rel)
            if os.path.exists(dst) and same_content(src, dst):
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            print(f"synced {rel}", flush=True)


def main():
    if len(sys.argv) > 2:
        print("usage: sync_vite.py [目标 .vite 目录]", file=sys.stderr)
        sys.exit(2)
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".vite")
    dst = os.path.abspath(sys.argv[1]) if len(sys.argv) == 2 else DEFAULT_DST
    print(f"syncing {src} -> {dst} every {INTERVAL}s", flush=True)
    while True:
        try:
            sync_once(src, dst)
        except OSError as e:
            print(f"sync error: {e}", file=sys.stderr, flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
