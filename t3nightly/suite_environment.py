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
paths = []
def add(directory):
    directory = directory.resolve()
    if directory.is_dir() and str(directory) not in paths:
        paths.append(str(directory))
for relative in (".vite-plus", ".local/share/vite-plus"):
    source = original_home / relative
    if not source.exists():
        continue
    source = source.resolve()
    link = home / relative
    link.parent.mkdir(parents=True, exist_ok=True)
    if not link.exists():
        link.symlink_to(source, target_is_directory=True)
    for directory in (source / "current/bin", source / "bin"):
        add(directory)
    version = json.loads((root / "package.json").read_text()).get("engines", {}).get("node", "")
    add(source / "js_runtime/node" / version / "bin")
    for package in sorted((source / "package_manager/pnpm").glob("*/pnpm/bin"), reverse=True):
        add(package)
for relative in (".rustup", ".cargo"):
    source = original_home / relative
    if source.is_dir() and not (home / relative).exists():
        (home / relative).symlink_to(source.resolve(), target_is_directory=True)
add(original_home / ".cargo/bin")
for directory in sorted((original_home / ".rustup/toolchains").glob("*/bin")):
    add(directory)
for name in ("uv", "uvx"):
    source = original_home / ".local/bin" / name
    if source.is_file() and not (tools / name).exists():
        (tools / name).symlink_to(source.resolve())
add(tools)
for directory in ("/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"):
    add(pathlib.Path(directory))
if sys.platform == "darwin":
    import subprocess
    add(pathlib.Path("/opt/homebrew/bin"))
    developer = subprocess.check_output(["/usr/bin/xcode-select", "-p"], text=True).strip()
    for relative in ("usr/bin", "Toolchains/XcodeDefault.xctoolchain/usr/bin"):
        add(pathlib.Path(developer) / relative)
add(root / "node_modules/.bin")
env = {"LANG": "en_US.UTF-8" if sys.platform == "darwin" else "C.UTF-8", "CI": "true",
       "CC": "/usr/bin/cc", "CXX": "/usr/bin/c++",
       "RUNNER_TEMP": str(root / ".advisory-tmp"),
       "GITHUB_OUTPUT": str(root / ".advisory-tmp/github-output"),
       "GITHUB_STEP_SUMMARY": str(root / ".advisory-tmp/github-summary")}
env.update(values)
env.update(HOME=str(home), PATH=os.pathsep.join(paths),
           TMPDIR=str(home / "tmp"), XDG_CONFIG_HOME=str(home / ".config"),
           XDG_CACHE_HOME=str(home / ".cache"), GIT_CONFIG_GLOBAL=str(home / ".gitconfig"),
           GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="core.hooksPath",
           GIT_CONFIG_VALUE_0=str(home / "hooks"), GIT_TERMINAL_PROMPT="0",
           PNPM_CONFIG_VIRTUAL_STORE_TYPE="local", PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE="false",
           PNPM_CONFIG_VIRTUAL_STORE_DIR=str(root / "node_modules/.pnpm"))
env["PLAYWRIGHT_BROWSERS_PATH"] = str(original_home / ("Library/Caches/ms-playwright" if sys.platform == "darwin" else ".cache/ms-playwright"))
env["electron_config_cache"] = str(original_home / ("Library/Caches/electron" if sys.platform == "darwin" else ".cache/electron"))
env["ELECTRON_CACHE"] = env["electron_config_cache"]
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

    temp = pathlib.Path("/srv/cow/t3-wt/.advisory-tmp") / ("advisory-" + hashlib.sha256(os.path.normpath(sys.argv[1]).encode()).hexdigest()[:16])
    temp.mkdir(parents=True, exist_ok=True)
    if temp.resolve() != temp:
        raise RuntimeError("advisory tmp must not be a symlink")
    env["TMPDIR"] = str(temp)
    env["XDG_CACHE_HOME"] = "/srv/cow/t3-wt/.advisory-cache"
    env["PNPM_CONFIG_CACHE_DIR"] = "/srv/cow/t3-wt/.advisory-cache/pnpm"
words = [str(original_home / word[2:]) if word.startswith("~/") else word for word in words]
if "--store-dir" in words:
    store = root.parent / ".advisory-pnpm-store"
    store.mkdir(parents=True, exist_ok=True)
    words[words.index("--store-dir") + 1] = str(store)
    method = "hardlink" if store.stat().st_dev == root.stat().st_dev else "auto"
    if "--package-import-method" in words:
        words[words.index("--package-import-method") + 1] = method
os.chdir(root)
os.execvpe(words[0], words, env)
'''


DISK = r'''
import json
import os
import sys
from pathlib import Path
root = Path(sys.argv[1])
if len(sys.argv) > 2 and sys.argv[2] == "free":
    info = os.statvfs(root.parent)
    print(json.dumps({"freeBytes": info.f_bfree * info.f_frsize}))
    sys.exit(0)
seen = set()
counts = {"worktreeBytes": 0, "virtualStoreBytes": 0}
for base, dirs, files in os.walk(root):
    for name in files:
        entry = Path(base) / name
        stat = entry.lstat()
        identity = (stat.st_dev, stat.st_ino)
        if identity in seen or stat.st_nlink != 1:
            continue
        seen.add(identity)
        size = stat.st_blocks * 512
        if sys.platform.startswith("linux") and entry.is_file() and not entry.is_symlink():
            import fcntl
            import struct
            buffer = bytearray(32 + 256 * 56)
            start = 0
            shared = 0
            try:
                with entry.open("rb") as handle:
                    while True:
                        struct.pack_into("=QQIIII", buffer, 0, start, (1 << 64) - 1 - start, 1, 0, 256, 0)
                        fcntl.ioctl(handle.fileno(), 0xC020660B, buffer, True)
                        count = struct.unpack_from("=I", buffer, 20)[0]
                        if not count:
                            break
                        for index in range(count):
                            logical, physical, length, r1, r2, flags, r3, r4, r5 = struct.unpack_from("=QQQQQIIII", buffer, 32 + index * 56)
                            if flags & 0x2000:
                                shared += length
                            start = logical + length
                        if flags & 1:
                            break
                size = max(0, size - shared)
            except OSError:
                counts["unclassifiedBytes"] = counts.get("unclassifiedBytes", 0) + size
                size = 0
        elif sys.platform == "darwin":
            counts["unclassifiedBytes"] = counts.get("unclassifiedBytes", 0) + size
            size = 0
        counts["worktreeBytes"] += size
        if root / "node_modules/.pnpm" in entry.parents:
            counts["virtualStoreBytes"] += size
print(json.dumps({**counts, "virtualStore": str(root / "node_modules/.pnpm"), "accounting": "private allocated bytes: excludes hardlinks and Linux FIEMAP shared extents; unsupported extents reported separately"}))
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
        if re.search(r"(?:TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL|PRIVATE.KEY|Bearer\s|npm_[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)|(?:\b[A-Z_][A-Z_0-9]*=)", line, re.I):
            lines.append("[redacted diagnostic line]")
            continue
        line = re.sub(r"[a-zA-Z][a-zA-Z0-9+.-]*://\S+", "[redacted URL]", line)
        line = re.sub(r"\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+", "[redacted token]", line)
        lines.append(line)
    return "\n".join(lines)
