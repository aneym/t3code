import os
from pathlib import Path


SHIM = r'''#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
name = Path(sys.argv[0]).name
if name == "sudo":
    assignments = {}
    while args:
        option = args[0]
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", option):
            key, value = args.pop(0).split("=", 1)
            assignments[key] = value
            continue
        if not option.startswith("-") or option == "-":
            break
        args.pop(0)
        if option == "--":
            break
        takes_value = False
        if option.startswith("--"):
            takes_value = option in ("--user", "--group", "--host", "--prompt", "--close-from", "--command-timeout", "--chdir", "--chroot")
        else:
            for index, flag in enumerate(option[1:], 1):
                if flag in "ughpCTDR":
                    takes_value = index == len(option) - 1
                    break
        if takes_value:
            if not args:
                print("t3nightly: sudo option requires a value: " + option, file=sys.stderr)
                sys.exit(1)
            args.pop(0)
    os.environ.update(assignments)
    if args and Path(args[0]).name == "sed" and "-i" in args:
        targets = args[args.index("-i") + 2:]
        if targets and all(str(Path(target).resolve()).startswith("/etc/apt/") for target in targets):
            sys.exit(0)
    if not args:
        sys.exit(1)
    try:
        os.execvp(args[0], args)
    except OSError as error:
        print("t3nightly: cannot execute sudo command: " + str(error), file=sys.stderr)
        sys.exit(1)
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
    print("t3nightly: unsupported apt action: " + (action or "<missing>") + "; only update and install are supported", flush=True)
    sys.exit(100)
missing = []
for requested in actions:
    if "/" in requested or ".." in requested:
        print("t3nightly: invalid apt package: " + requested, file=sys.stderr)
        sys.exit(100)
    package = requested.split("=", 1)[0].split(":", 1)[0]
    if not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", package):
        print("t3nightly: invalid apt package: " + requested, file=sys.stderr)
        sys.exit(100)
    status = subprocess.run(["dpkg-query", "-W", "-f=${Status}", package], capture_output=True, text=True)
    marker = Path.home() / ".local/t3nightly-apt/installed" / package
    if status.stdout.strip() != "install ok installed" and not marker.is_file():
        missing.append(package)
if missing:
    print("t3nightly: missing apt packages: " + ", ".join(missing), flush=True)
    with open(os.environ["T3NIGHTLY_MISSING_PACKAGES"], "a") as handle:
        handle.write(json.dumps({"exit": 100, "missingPackages": missing}) + "\n")
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
    return '{ export CC=/usr/bin/gcc CXX=/usr/bin/g++ && if test -d "$HOME/.local/t3nightly-apt/root"; then export ' + paths + '; fi; }'


def studio_path(tree):
    return f"{tree}/node_modules/.bin:{Path.home()}/.vite-plus/bin:/opt/homebrew/bin:" + os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")
