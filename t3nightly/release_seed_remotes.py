import shlex

from .release_transport import require


def commands(config):
    archive = config.run / config.archive("linux-x64")
    runtime = f'"$HOME/.t3/runtime/versions/{config.version}"'
    upload = f"/tmp/t3-runtime-{config.version}.tar.gz"
    rows = []
    for host in (config.linux_host, "pc-wsl"):
        cleanup = shlex.quote(f'rm -rf "$staging" "{upload}"')
        script = "set -eu; " + "; ".join((
            'staging="$(mktemp -d "$HOME/.t3/runtime/versions/.staging-XXXXXX")"',
            f"trap {cleanup} EXIT",
            f'tar -xzf {shlex.quote(upload)} -C "$staging" --strip-components=1',
            '"$staging/t3" --version >/dev/null 2>&1',
            f'printf {shlex.quote("%s\\n")} {shlex.quote(config.version)} > "$staging/.install-complete"',
            f"rm -rf {runtime}",
            f'mv "$staging" {runtime}',
        ))
        rows.extend((
            ["ssh", "-o", "BatchMode=yes", host, 'mkdir -p "$HOME/.t3/runtime/versions"'],
            ["rsync", "-a", "--", str(archive), f"{host}:{upload}"],
            ["ssh", "-o", "BatchMode=yes", host, script],
        ))
    return rows


def seed(config, log, dry_run=False):
    for words in commands(config):
        log.write("$ " + shlex.join(words) + "\n")
        if not dry_run:
            require(words, log)
    return 0
