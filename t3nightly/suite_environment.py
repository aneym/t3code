import re
from pathlib import Path


CHILD = r'''
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
values, words = json.loads(sys.argv[2]), json.loads(sys.argv[3])
original_home = pathlib.Path.home()
home = root / ".advisory-home"
tools = home / "toolchain"
tools.mkdir(parents=True, exist_ok=True)
(home / ".gitconfig").touch()
(home / "tmp").mkdir(exist_ok=True)
(home / "hooks").mkdir(exist_ok=True)
vp_root = original_home / ".local/share/vite-plus"
if not vp_root.exists():
    vp_root = original_home / ".vite-plus"
cache = home / ".local/share/vite-plus"
cache.parent.mkdir(parents=True, exist_ok=True)
if not cache.exists():
    cache.symlink_to(vp_root, target_is_directory=True)
vp = vp_root / "current/bin/vp"
if not vp.exists():
    vp = vp_root / "bin/vp"
node = None
for base in (original_home / ".vite-plus/js_runtime/node", vp_root / "js_runtime/node"):
    manifest = root / "package.json"
    version = json.loads(manifest.read_text()).get("engines", {}).get("node", "")
    candidate = base / version / "bin/node"
    if candidate.is_file():
        node = candidate
        break
if node is None:
    node = pathlib.Path("/usr/local/bin/node").resolve()
targets = {"node": node, "vp": vp.resolve(), "vpr": vp.resolve(), "vpx": vp.resolve()}
for package in (vp_root / "package_manager/pnpm").glob("*/pnpm/bin/pnpm"):
    targets["pnpm"] = package
for toolchain in (original_home / ".rustup/toolchains").glob("*/bin"):
    for name in ("cargo", "rustc", "rustfmt", "clippy-driver"):
        if (toolchain / name).is_file():
            targets[name] = toolchain / name
for name, target in targets.items():
    link = tools / name
    if not link.exists():
        link.symlink_to(target)
env = {"LANG": "en_US.UTF-8" if sys.platform == "darwin" else "C.UTF-8", "CI": "true",
       "CC": "/usr/bin/cc", "CXX": "/usr/bin/c++",
       "RUNNER_TEMP": str(root / ".advisory-tmp"),
       "GITHUB_OUTPUT": str(root / ".advisory-tmp/github-output"),
       "GITHUB_STEP_SUMMARY": str(root / ".advisory-tmp/github-summary")}
env.update(values)
env.update(HOME=str(home), PATH=f"{tools}:/usr/bin:/bin:/usr/sbin:/sbin:{root}/node_modules/.bin",
           TMPDIR=str(home / "tmp"), XDG_CONFIG_HOME=str(home / ".config"),
           XDG_CACHE_HOME=str(home / ".cache"), GIT_CONFIG_GLOBAL=str(home / ".gitconfig"),
           GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="core.hooksPath",
           GIT_CONFIG_VALUE_0=str(home / "hooks"), GIT_TERMINAL_PROMPT="0",
           PNPM_CONFIG_VIRTUAL_STORE_TYPE="local", PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE="false",
           PNPM_CONFIG_VIRTUAL_STORE_DIR=str(root / "node_modules/.pnpm"))
if sys.platform == "darwin":
    env["PATH"] += ":/opt/homebrew/bin"
native = original_home / ".local/t3nightly-apt"
if native.is_dir():
    local = home / ".local/t3nightly-apt"
    if not local.exists():
        local.symlink_to(native, target_is_directory=True)
    prefix = native / "root/usr"
    env.update(PKG_CONFIG_PATH=f"{prefix}/lib/x86_64-linux-gnu/pkgconfig:{prefix}/share/pkgconfig",
               LD_LIBRARY_PATH=f"{prefix}/lib/x86_64-linux-gnu:{prefix}/lib",
               LIBRARY_PATH=f"{prefix}/lib/x86_64-linux-gnu:{prefix}/lib", CPATH=str(prefix / "include"))
if sys.argv[4] == "ax42":
    import hashlib

    temp = pathlib.Path("/srv/cow/t3-wt/.advisory-tmp") / ("advisory-" + hashlib.sha256(str(root).encode()).hexdigest()[:16])
    temp.mkdir(parents=True, exist_ok=True)
    if temp.resolve() != temp:
        raise RuntimeError("advisory tmp must not be a symlink")
    env["TMPDIR"] = str(temp)
    env["XDG_CACHE_HOME"] = "/srv/cow/t3-wt/.advisory-cache"
    env["PNPM_CONFIG_CACHE_DIR"] = "/srv/cow/t3-wt/.advisory-cache/pnpm"
words = [str(original_home / word[2:]) if word.startswith("~/") else word for word in words]
if sys.platform == "darwin" and "--package-import-method" in words:
    words[words.index("--package-import-method") + 1] = "clone"
os.chdir(root)
os.execvpe(words[0], words, env)
'''


DISK = r'''
import json
import os
import sys
from pathlib import Path
root = Path(sys.argv[1])
seen = set()
counts = {"worktreeBytes": 0, "virtualStoreBytes": 0}
for base, dirs, files in os.walk(root):
    for name in files:
        entry = Path(base) / name
        stat = entry.lstat()
        identity = (stat.st_dev, stat.st_ino)
        if identity in seen:
            continue
        seen.add(identity)
        size = stat.st_blocks * 512
        counts["worktreeBytes"] += size
        if root / "node_modules/.pnpm" in entry.parents:
            counts["virtualStoreBytes"] += size
print(json.dumps({**counts, "virtualStore": str(root / "node_modules/.pnpm"), "accounting": "allocated bytes, hardlinks counted once; shared clone extents may overlap"}))
'''


def isolated(tree, words, values=None, host=None):
    import json

    values = {key: value for key, value in (values or {}).items()
              if not re.search(r"TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|KEY|^GIT_|^PNPM_|^NPM_|^PATH$|^HOME$|^NODE_OPTIONS$|^BASH_ENV$|^ENV$|^LD_|^DYLD_", key, re.I)
              and not re.search(r"\$\{\{\s*(?:secrets|env)\.", str(value), re.I)}
    return ["python3", "-c", CHILD, str(tree), json.dumps(values), json.dumps(words), host or "local"]


def sanitized_tail(path):
    with Path(path).open("rb") as handle:
        handle.seek(0, 2)
        handle.seek(max(0, handle.tell() - 16000))
        text = handle.read().decode(errors="replace")
    lines = []
    for line in text.splitlines()[-60:]:
        if re.search(r"(?:TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL|PRIVATE.KEY)|(?:\b[A-Z_][A-Z_0-9]*=)", line, re.I):
            lines.append("[redacted diagnostic line]")
            continue
        line = re.sub(r"https?://\S+", "[redacted URL]", line)
        line = re.sub(r"\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+", "[redacted token]", line)
        lines.append(line)
    return "\n".join(lines)
