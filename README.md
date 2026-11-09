# t3nightly

The release engine for the aneym T3 Code nightly builds: assemble, gate, smoke, sign, publish the feed and install. This orphan branch holds only the engine; it never merges into a build candidate.

Run any entry point with the branch root on `PYTHONPATH`:

```sh
PYTHONPATH=/Volumes/StudioExt/repos/t3code-wt/t3nightly python3 t3nightly/publish-feed <run-dir> --desktop-dir <run-dir>/desktop --feed-dir /Volumes/StudioExt/t3nightly-feed --verdict <run-dir>/visual-verdict.md
```

## Public mirror

`publish-feed` also mirrors each published CLI release to the public T3 mirror that `https://one.rails.so/t3` serves, so `T3CODE_RELEASE_BASE_URL=https://one.rails.so/t3` works for T3's own `install.sh` and `t3 update`. The mirror runs when `~/.config/t3nightly/public-mirror.json` exists (`T3NIGHTLY_PUBLIC_MIRROR` names another path); a mirror failure fails the publish. With no config it prints `publicMirror: skipped`.

```json
{"target": "r2", "endpoint": "https://<account>.r2.cloudflarestorage.com", "bucket": "rails-desktop", "prefix": "t3", "keyIdSecret": "<agent-secret name>", "secretSecret": "<agent-secret name>", "sessionTokenSecret": "<agent-secret name>"}
```

`sessionTokenSecret` is optional: set it for temporary R2 credentials, and every request carries the token as a signed `x-amz-security-token` header. Leave it out for a long-lived key.

`{"target": "dir", "path": "<dir>"}` writes a local directory instead. Keys under the prefix: `v<version>/t3-<version>-<platform>-<arch>.tar.gz`, `v<version>/SHA256SUMS`, then `releases.json` (feed schema, `desktop: []`), then `pin.json` (`{"version": ...}`) last. Every darwin CLI must pass the Developer ID and notarization check first. The pin moves only to the newest release. `t3nightly/public-mirror publish <version>` backfills one feed version, `public-mirror pin <version>` moves the pin (rollback), and `public-mirror status` prints both; `--dir <path>` aims any of them at a local directory.

## Studio uplink

Studio has a 24 Mbps uplink, so the fast release keeps bulk uploads off it during the day. `t3nightly/release_uplink.py` holds the one cap setting, `UPLINK_KBPS` (default 1000 KB/s, about 8 Mbps): every outbound bulk rsync from Studio gets `--bwlimit`, the Windows source scp gets `-l`, and the public mirror's R2 upload is paced to the same rate. Inbound pulls to Studio and tiny copies are uncapped.

Nodes that upload from Studio (`M` and `D` notarize through notarytool, which cannot be rate-capped; `SM` and `SD` prestage to the Linux builder; `W` ships the Windows source; `F` may push the public mirror) start only inside `--uplink-window`, default `05:00-12:00` UTC. Outside it the scheduler holds them without failing and prints `deferredUntil`; Linux nodes keep running. `--uplink-window off` starts them at once for an emergency. The Linux builder (`--linux-host`) copies its artifact straight to the other Linux hosts (`T*` nodes run on the builder), so no Linux artifact leaves Studio; `SL` still pulls it to Studio for the feed.

Land engine changes here with fast-forward pushes to `aneym/t3nightly` on git@github.com:aneym/t3code.git. Linux hosts take a copy with `git archive aneym/t3nightly | ssh <host> tar -x -C t3nightly/engine-<sha>`.

Source: moved from open-factory `engine/t3nightly` at 3c2abf5fe; the load-guard reader that came from `fleet.factory` now lives in `t3nightly/load_guard.py`.
