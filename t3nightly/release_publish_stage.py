import hashlib
import json
import shlex
import shutil
import subprocess
from pathlib import Path

from .build_artifacts import load
from .release_transport import require, ssh


def sha256(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def files(config, stage):
    if stage == 'SM':
        return config.build_out(), config.artifact(), [config.archive()]
    if stage == 'SD':
        directory = config.run / 'desktop'
        name = f'T3-Code-{config.version}-arm64.zip'
        return directory, directory / 'artifact-desktop-darwin-arm64.json', [name, f'{name}.blockmap', 'nightly-mac.yml']
    remote = config.on('ax42')
    return config.run / 'ax42', config.run / 'ax42' / remote.artifact().name, [remote.archive()]


def verify_local(config, stage):
    directory, manifest_path, names = files(config, stage)
    manifest = load(manifest_path)
    expected = ('desktop', 'darwin', 'arm64') if stage == 'SD' else ('cli', 'linux' if stage == 'SL' else 'darwin', 'x64' if stage == 'SL' else 'arm64')
    if (manifest['kind'], manifest['platform'], manifest['arch']) != expected or manifest['release'] != config.version or manifest['archive']['name'] != names[0]:
        raise ValueError(f'{manifest_path}: artifact identity mismatch')
    hashes = {name: sha256(directory / name) for name in names}
    if hashes[names[0]] != manifest['archive']['sha256']:
        raise ValueError(f'{directory / names[0]}: artifact hash mismatch')
    return directory, manifest_path, hashes


def remote_verify(config, stage, hashes):
    root = config.on('ax42').run / 'publish-staged' / stage
    script = "import hashlib,pathlib,sys; p=pathlib.Path(sys.argv[1]); pairs=zip(sys.argv[2::2],sys.argv[3::2]); sys.exit(any(hashlib.file_digest((p/n).open('rb'),'sha256').hexdigest()!=h for n,h in pairs))"
    args = ['python3', '-c', script, str(root), *(item for pair in hashes.items() for item in pair)]
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', config.linux_host, shlex.join(args)], capture_output=True, text=True, check=False)
    if result.returncode:
        raise ValueError(f'{stage}: remote staged hash verification failed: {result.stderr[-300:]}')


def validate(config, stage):
    directory, manifest, hashes = verify_local(config, stage)
    receipt = json.loads((config.run / f'publish-stage-{stage}.json').read_text())
    if receipt != {'manifest': sha256(manifest), 'files': hashes}:
        raise ValueError(f'{stage}: staged payload changed')
    if stage in ('SM', 'SD'):
        remote_verify(config, stage, {**hashes, manifest.name: sha256(manifest)})
    if stage in ('SM', 'SL'):
        name = next(iter(hashes))
        if sha256(config.run / 'publish' / name) != hashes[name]:
            raise ValueError(f'{stage}: local publish payload changed')
    return True


def stage_payload(config, stage, log):
    remote = config.on('ax42')
    if stage == 'SL':
        directory = config.run / 'ax42'
        directory.mkdir(exist_ok=True)
        require(['rsync', '-a', '--partial', '--', f'{config.linux_host}:{remote.artifact()}', f'{config.linux_host}:{remote.build_out() / remote.archive()}', str(directory) + '/'], log)
    directory, manifest, hashes = verify_local(config, stage)
    if stage in ('SM', 'SD'):
        dest = remote.run / 'publish-staged' / stage
        if ssh(['mkdir', '-p', str(dest)], log, config.linux_host):
            raise RuntimeError(f'{stage}: cannot create remote staging directory')
        require(['rsync', '-a', '--partial', '--', *(str(directory / name) for name in hashes), str(manifest), f'{config.linux_host}:{dest}/'], log)
        remote_verify(config, stage, {**hashes, manifest.name: sha256(manifest)})
    if stage in ('SM', 'SL'):
        publish = config.run / 'publish'
        publish.mkdir(exist_ok=True)
        name = next(iter(hashes))
        shutil.copy2(directory / name, publish / name)
    (config.run / f'publish-stage-{stage}.json').write_text(json.dumps({'manifest': sha256(manifest), 'files': hashes}, indent=2) + '\n')
    return 0
