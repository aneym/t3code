import os
import shlex
import shutil
import sys
from pathlib import Path

from .codex_isolation import isolated_codex_home

AGENT_LB_URL = "http://127.0.0.1:2455"
LB_TOKEN = "t3nightly-headless"
NOT_FOUND = 44


def claude_lb_lines(bin_dir):
    return [
        "unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLAUDE_LB_GUARD",
        f"export ANTHROPIC_BASE_URL={AGENT_LB_URL} ANTHROPIC_AUTH_TOKEN={LB_TOKEN} CLAUDE_GUARD_OFF=1 DISABLE_AUTOUPDATER=1",
        f"export PATH={shlex.quote(str(bin_dir))}:\"$PATH\"",
    ]


def write_script(path, lines):
    path.write_text("\n".join(lines) + "\n")
    path.chmod(0o700)
    return path


def real_claude(bin_dir):
    installed = Path.home() / ".local/bin/claude"
    if installed.is_file() and os.access(installed, os.X_OK):
        return installed.resolve()
    search = os.pathsep.join(entry for entry in os.environ.get("PATH", "").split(os.pathsep) if Path(entry) != bin_dir)
    found = shutil.which("claude", path=search)
    return Path(found) if found else None


def headless_bin(root, refusals):
    root = Path(root).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    write_script(root / "security", [
        "#!/bin/sh",
        "service= previous=",
        "for arg in \"$@\"; do [ \"$previous\" = -s ] && service=$arg; previous=$arg; done",
        f"printf '%s %s\\n' \"${{1:-}}\" \"$service\" >> {shlex.quote(str(refusals))}",
        f"exit {NOT_FOUND}",
    ])
    binary = real_claude(root)
    if binary is not None:
        write_script(root / "claude", ["#!/bin/sh", *claude_lb_lines(root), f"exec {shlex.quote(str(binary))} \"$@\""])
    return root


def provider_env(work, refusals=None, path=None):
    work = Path(work)
    env = {"CODEX_HOME": str(isolated_codex_home(work / "codex-home")), "GIT_TERMINAL_PROMPT": "0"}
    if sys.platform == "darwin":
        root = headless_bin(work / "headless-bin", Path(refusals or work / "security-refusals.log").resolve())
        env["PATH"] = os.pathsep.join([str(root), os.environ.get("PATH", "") if path is None else path])
    return env
