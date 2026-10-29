import tomllib
from pathlib import Path

STORES = {"cli_auth_credentials_store": "file", "mcp_oauth_credentials_store": "file"}


def parsed_keys(line):
    try:
        return set(tomllib.loads(line))
    except tomllib.TOMLDecodeError:
        return set()


def without_store_keys(lines):
    current = list(lines)
    for line in lines:
        keys = parsed_keys(line) & STORES.keys()
        if not keys:
            continue
        trial = list(current)
        trial.remove(line)
        before = tomllib.loads("".join(current))
        try:
            after = tomllib.loads("".join(trial))
        except tomllib.TOMLDecodeError:
            continue
        if after == {key: value for key, value in before.items() if key not in keys}:
            current = trial
    return current


def isolated_codex_home(root):
    root = Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    source = Path.home() / ".codex/config.toml"
    lines = source.read_text().splitlines(keepends=True) if source.is_file() else []
    text = "".join(f'{key} = "{value}"\n' for key, value in STORES.items()) + "".join(without_store_keys(lines))
    parsed = tomllib.loads(text)
    if any(parsed.get(key) != value for key, value in STORES.items()):
        raise ValueError("isolated codex config does not force file credential storage")
    config = root / "config.toml"
    config.write_text(text)
    config.chmod(0o600)
    return root
