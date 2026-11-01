import os
from pathlib import Path


SHIM = r'''#!/usr/bin/env python3
import os
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
name = Path(sys.argv[0]).name
if name == "sudo":
    while args and args[0].startswith("-"):
        option = args.pop(0)
        if option == "--":
            break
        if option in ("-u", "-g", "-h", "-p", "-C", "-T", "--user", "--group", "--host", "--prompt", "--close-from", "--command-timeout"):
            args.pop(0)
    if args and Path(args[0]).name == "sed" and "-i" in args:
        targets = args[args.index("-i") + 2:]
        if targets and all(str(Path(target).resolve()).startswith("/etc/apt/") for target in targets):
            sys.exit(0)
    if not args:
        sys.exit(1)
    os.execvp(args[0], args)
actions = []
while args:
    arg = args.pop(0)
    if arg in ("-o", "--option", "-c", "--config-file", "-t", "--target-release", "-a", "--host-architecture"):
        if args:
            args.pop(0)
    elif not arg.startswith("-"):
        actions.append(arg)
action = actions.pop(0) if actions else ""
if action == "update":
    sys.exit(0)
if action != "install":
    print("t3nightly: unsupported apt action: " + action, flush=True)
    sys.exit(100)
missing = []
for package in actions:
    status = subprocess.run(["dpkg-query", "-W", "-f=${Status}", package], capture_output=True, text=True)
    marker = Path.home() / ".local/t3nightly-apt/installed" / package
    if status.stdout.strip() != "install ok installed" and not marker.is_file():
        missing.append(package)
for package in missing:
    print("T3NIGHTLY_MISSING_PACKAGE:" + package, flush=True)
    with open(os.environ["T3NIGHTLY_MISSING_PACKAGES"], "a") as handle:
        handle.write("T3NIGHTLY_MISSING_PACKAGE:" + package + "\n")
sys.exit(100 if missing else 0)
'''


def setup_script(temp):
    folder = f"{temp}/shims"
    script = "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(parents=True,exist_ok=True); "
    script += "[(p.joinpath(n).write_text(sys.argv[2]),p.joinpath(n).chmod(0o755)) for n in ('sudo','apt','apt-get')]"
    return ["python3", "-c", script, folder, SHIM]


def linux_exports():
    prefix = '$HOME/.local/t3nightly-apt/root/usr'
    values = {
        "PKG_CONFIG_PATH": f"{prefix}/lib/x86_64-linux-gnu/pkgconfig:{prefix}/share/pkgconfig",
        "LD_LIBRARY_PATH": f"{prefix}/lib/x86_64-linux-gnu:{prefix}/lib",
        "LIBRARY_PATH": f"{prefix}/lib/x86_64-linux-gnu:{prefix}/lib",
        "CPATH": f"{prefix}/include",
    }
    paths = " ".join(f'{key}="{value}${{{key}:+:${key}}}"' for key, value in values.items())
    return 'export CC=/usr/bin/gcc CXX=/usr/bin/g++; if test -d "$HOME/.local/t3nightly-apt/root"; then export ' + paths + '; fi'


def studio_path(tree):
    return f"{tree}/node_modules/.bin:{Path.home()}/.vite-plus/bin:/opt/homebrew/bin:" + os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")
