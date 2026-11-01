import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path


def output(words):
    return subprocess.run(words, capture_output=True, text=True, check=True).stdout


def installed(package):
    result = subprocess.run(["dpkg-query", "-W", "-f=${Status}", package], capture_output=True, text=True)
    return result.stdout.strip() == "install ok installed"


def concrete(package):
    if subprocess.run(["apt-cache", "show", package], capture_output=True, text=True).stdout.strip():
        return package
    providers = output(["apt-cache", "showpkg", package]).split("Reverse Provides:")[-1].splitlines()
    names = [line.split()[0] for line in providers if line.strip()]
    if not names:
        raise RuntimeError(f"no package provides {package}")
    return next((name for name in names if installed(name)), names[0])


def build(packages):
    prefix = Path.home() / ".local/t3nightly-apt"
    root = prefix / "root"
    markers = prefix / "installed"
    root.mkdir(parents=True, exist_ok=True)
    markers.mkdir(exist_ok=True)
    pending = list(packages)
    seen = set()
    downloads = []
    while pending:
        package = concrete(pending.pop(0))
        if package in seen:
            continue
        seen.add(package)
        if installed(package):
            continue
        if not (markers / package).is_file():
            downloads.append(package)
        dependencies = output(["apt-cache", "depends", package])
        alternatives = False
        for line in dependencies.splitlines():
            match = re.match(r"\s*(\|?)(?:PreDepends|Depends):\s*<?([^>\s]+)>?", line)
            if match:
                if not alternatives:
                    pending.append(match[2])
                alternatives = bool(match[1])
    with tempfile.TemporaryDirectory(prefix="t3nightly-apt-") as scratch:
        for package in downloads:
            subprocess.run(["apt-get", "download", package], cwd=scratch, check=True)
        for archive in sorted(Path(scratch).glob("*.deb")):
            subprocess.run(["dpkg", "-x", str(archive), str(root)], check=True)
    for pc in root.rglob("*.pc"):
        pc.write_text(re.sub(r"(?m)^prefix=/usr$", f"prefix={root}/usr", pc.read_text()))
    lib = root / "usr/lib/x86_64-linux-gnu"
    if lib.exists():
        for link in lib.rglob("*.so*"):
            if link.is_symlink() and not link.exists():
                target = Path("/usr/lib/x86_64-linux-gnu") / link.resolve().name
                if target.exists():
                    link.unlink()
                    link.symlink_to(target)
    for folder in (root / "usr/bin", root / "usr/sbin", root / "bin", root / "sbin"):
        if folder.exists():
            for binary in folder.iterdir():
                if binary.name.startswith("qemu-") and (binary.is_file() or binary.is_symlink()):
                    binary.unlink()
    for package in downloads:
        (markers / package).write_text("extracted\n")
    return {"prefix": str(prefix), "satisfied": sorted(seen), "extracted": downloads}


def main():
    parser = argparse.ArgumentParser(description="Build a rootless advisory apt prefix over SSH.")
    parser.add_argument("--host", required=True)
    parser.add_argument("packages", nargs="+")
    args = parser.parse_args()
    import shlex
    script = Path(__file__).read_text() + '\nprint(json.dumps(build(__import__("sys").argv[1:])))\n'
    return subprocess.run(["ssh", "-o", "BatchMode=yes", args.host, shlex.join(["python3", "-", *args.packages])], input=script, text=True).returncode
