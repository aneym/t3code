import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from .preview_state import write_private

SECRET = re.compile(r"(?i)((?:[\w-]*token|password|secret|authorization)[\"']?\s*[:=]\s*[\"']?)([^\s&\"']+)")
URL = re.compile(r"https?://[^\s\"'<>\x1b]+")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def redact(text):
    text = ANSI.sub("", text)
    text = re.sub(r"(?i)(pairing\s*url:|pairingUrl:).*", r"\1 REDACTED", text)
    text = URL.sub(lambda match: match.group(0).split("?")[0].split("#")[0], text)
    return SECRET.sub(lambda match: match.group(1) + "REDACTED", text)


def shared_origin(line):
    if "[dev-runner] shared on tailnet:" not in line:
        return None
    match = URL.search(line)
    if not match:
        return None
    parsed = urlsplit(match.group(0).rstrip(".,)"))
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".ts.net"):
        return None
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def consume(source, log, pairing_path=None):
    with log.open("a", encoding="utf-8") as handle:
        os.chmod(log, 0o600)
        for line in source:
            line = ANSI.sub("", line)
            if pairing_path and re.search(r"(?i)pairing\s*url:", line):
                match = URL.search(line)
                if match:
                    write_private(pairing_path, match.group(0).rstrip(".,)") + "\n")
            handle.write(redact(line))
            handle.flush()


def main():
    with open(sys.stdin.fileno(), encoding="utf-8", errors="replace", closefd=False) as source:
        consume(source, Path(sys.argv[1]), Path(sys.argv[2]) if sys.argv[2] != "-" else None)


if __name__ == "__main__":
    main()
