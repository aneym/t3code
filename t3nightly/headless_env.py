import json
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
        'export NO_PROXY="127.0.0.1,localhost,::1${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1,localhost,::1${no_proxy:+,$no_proxy}"',
        f"export PATH={shlex.quote(str(bin_dir))}:\"$PATH\"",
    ]


def write_script(path, lines):
    path.write_text("\n".join(lines) + "\n")
    path.chmod(0o700)
    return path


def real_claude(bin_dir):
    own = (bin_dir / "claude").resolve()
    installed = (Path.home() / ".local/bin/claude").resolve()
    if installed.is_file() and os.access(installed, os.X_OK) and installed != own and installed.parent != bin_dir:
        return installed
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        found = shutil.which("claude", path=entry) if entry else None
        if found and Path(found).resolve() != own and Path(entry).resolve() != bin_dir:
            return Path(found)
    raise RuntimeError("no claude binary to pin for headless provider runs")


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
    write_script(root / "claude", ["#!/bin/sh", *claude_lb_lines(root), f"exec {shlex.quote(str(binary))} \"$@\""])
    return root


def provider_env(work):
    return {"CODEX_HOME": str(isolated_codex_home(Path(work) / "codex-home")), "GIT_TERMINAL_PROMPT": "0"}


def pin_settings(settings_path, work, refusals, keep=()):
    path = Path(settings_path)
    settings = json.loads(path.read_text()) if path.is_file() else {}
    settings["cursorKeychainUsageEnabled"] = False
    if sys.platform == "darwin":
        wrapper = headless_bin(Path(work) / "headless-bin", Path(refusals).resolve()) / "claude"
        instances = settings.get("providerInstances")
        instances = settings["providerInstances"] = instances if isinstance(instances, dict) else {}
        if not isinstance(instances.get("claudeAgent"), dict):
            instances["claudeAgent"] = {"driver": "claudeAgent"}
        kept = {str(Path(item)) for item in keep}
        for instance_id, instance in instances.items():
            default = "claudeAgent" if instance_id == "claudeAgent" else None
            if not isinstance(instance, dict) or instance.get("driver", default) != "claudeAgent":
                continue
            config = instance["config"] = instance["config"] if isinstance(instance.get("config"), dict) else {}
            if config.get("binaryPath") not in kept:
                config["binaryPath"] = str(wrapper)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2) + "\n")
    return settings
