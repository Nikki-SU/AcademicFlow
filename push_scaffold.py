#!/usr/bin/env python3
"""通过 GitHub Git Data API 批量推送本地文件到 Nikki-SU/AcademicFlow 的 main 分支。"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

# 读取 PAT
SECRET_PATH = Path("/app/data/所有对话/主对话/SECRET.md")
m = re.search(r"ghp_[A-Za-z0-9]+", SECRET_PATH.read_text())
if not m:
    sys.exit("PAT not found in SECRET.md")
PAT = m.group(0)
print(f"PAT: {PAT[:10]}...")

REPO = "Nikki-SU/AcademicFlow"
BRANCH = "main"
SCAFFOLD_DIR = Path("/app/data/所有对话/主对话/academic_workflow_project/repo_scaffold_v0.3")

# 排除 workflow 文件（PAT 目前没有 workflow scope）
EXCLUDE_PREFIXES = (".github/",)

API = "https://api.github.com"
HEADERS = {
    "Authorization": f"Bearer {PAT}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "AcademicFlow-scaffold-uploader",
}


def api(method, path, body=None):
    url = API + path if path.startswith("/") else path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        **HEADERS,
        "Content-Type": "application/json" if body else "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.request.HTTPError as e:
        return e.code, json.loads(e.read().decode())


# 1. 收集本地文件
files = []
for p in SCAFFOLD_DIR.rglob("*"):
    if not p.is_file():
        continue
    rel = p.relative_to(SCAFFOLD_DIR).as_posix()
    if any(rel.startswith(x) for x in EXCLUDE_PREFIXES):
        print(f"  [skip workflow] {rel}")
        continue
    files.append((rel, p))
print(f"\n共 {len(files)} 个文件待推送\n")

# 2. 拉当前 main 分支 head commit 和 tree sha
status, ref = api("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")
assert status == 200, ref
head_commit_sha = ref["object"]["sha"]
status, head_commit = api("GET", f"/repos/{REPO}/git/commits/{head_commit_sha}")
assert status == 200, head_commit
base_tree_sha = head_commit["tree"]["sha"]
print(f"当前 main HEAD: {head_commit_sha[:8]}")
print(f"当前 tree:      {base_tree_sha[:8]}")

# 3. 为每个文件创建 blob
tree_entries = []
for rel, p in files:
    content = p.read_bytes()
    # 用 base64 编码兼容二进制/UTF-8 全字节
    import base64
    body = {
        "content": base64.b64encode(content).decode("ascii"),
        "encoding": "base64",
    }
    status, blob = api("POST", f"/repos/{REPO}/git/blobs", body)
    assert status == 201, (rel, blob)
    print(f"  blob {blob['sha'][:8]}  {rel}  ({len(content)} bytes)")
    tree_entries.append({
        "path": rel,
        "mode": "100644",
        "type": "blob",
        "sha": blob["sha"],
    })

# 4. 创建新 tree（base_tree 保留仓库现有其他文件，如 LICENSE）
status, tree = api("POST", f"/repos/{REPO}/git/trees", {
    "base_tree": base_tree_sha,
    "tree": tree_entries,
})
assert status == 201, tree
print(f"\n新 tree:   {tree['sha'][:8]}")

# 5. 创建 commit
commit_msg = "chore(m0): scaffold Vite + React + TS + Tailwind (14 files, workflow pending)"
status, commit = api("POST", f"/repos/{REPO}/git/commits", {
    "message": commit_msg,
    "tree": tree["sha"],
    "parents": [head_commit_sha],
})
assert status == 201, commit
print(f"新 commit: {commit['sha'][:8]}  {commit_msg}")

# 6. 更新 main 分支 ref
status, updated = api("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}", {
    "sha": commit["sha"],
    "force": False,
})
assert status == 200, updated
print(f"\n✅ main 已推进到 {commit['sha'][:8]}")
print(f"仓库地址: https://github.com/{REPO}")
