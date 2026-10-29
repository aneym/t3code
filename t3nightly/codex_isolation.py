from pathlib import Path

FILE_STORES = 'cli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n'
STORE_KEYS = ("cli_auth_credentials_store", "mcp_oauth_credentials_store")


def isolated_codex_home(root):
    root = Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    source = Path.home() / ".codex/config.toml"
    lines = source.read_text().splitlines(keepends=True) if source.is_file() else []
    kept = "".join(line for line in lines if not line.lstrip().startswith(STORE_KEYS))
    config = root / "config.toml"
    config.write_text(FILE_STORES + kept)
    config.chmod(0o600)
    return root
