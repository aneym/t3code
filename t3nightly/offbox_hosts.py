import shlex
from pathlib import PurePosixPath

QUICK_CHECK_PY = "import sqlite3,sys; print(sqlite3.connect('file:'+sys.argv[1]+'?mode=ro', uri=True).execute('PRAGMA quick_check').fetchone()[0])"

PROFILES = {
    "studio": {"root": PurePosixPath("/Volumes/StudioExt/t3nightly-install-data/remote"), "zstd": "/opt/homebrew/bin/zstd",
               "rsync": "/Users/aneyman/.local/bin/sqlite3_rsync", "clone": "cp -c", "check": "sqlite3"},
    "ax102": {"root": PurePosixPath("/home/jobs/t3nightly-install-data/remote"), "zstd": "/usr/bin/zstd",
              "rsync": "/home/jobs/.local/bin/sqlite3_rsync", "clone": "cp --reflink=auto", "check": "python3"},
}


def profile(host):
    found = PROFILES.get(host)
    if found is None:
        raise ValueError(f"--offbox host must be one of {', '.join(sorted(PROFILES))}")
    return found


def root(host):
    return profile(host)["root"]


def quick_check_command(host, quoted_path):
    if profile(host)["check"] == "python3":
        return f"python3 -I -c {shlex.quote(QUICK_CHECK_PY)} {quoted_path}"
    return f"sqlite3 {quoted_path} 'PRAGMA quick_check'"


def remote_rsync(origin, replica):
    for address in (str(origin), str(replica)):
        host, separator, _ = address.partition(":")
        if separator and not address.startswith("/"):
            return profile(host)["rsync"]
    raise ValueError("sqlite3_rsync needs one HOST:/path side")
