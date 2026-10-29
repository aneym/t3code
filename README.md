# t3nightly

The release engine for the aneym T3 Code nightly builds: assemble, gate, smoke, sign, publish the feed and install. This orphan branch holds only the engine; it never merges into a build candidate.

Run any entry point with the branch root on `PYTHONPATH`:

```sh
PYTHONPATH=/Volumes/StudioExt/repos/t3code-wt/t3nightly python3 t3nightly/publish-feed <run-dir> --desktop-dir <run-dir>/desktop --feed-dir /Volumes/StudioExt/t3nightly-feed --verdict <run-dir>/visual-verdict.md
```

Land engine changes here with fast-forward pushes to `aneym/t3nightly` on git@github.com:aneym/t3code.git. Linux hosts take a copy with `git archive aneym/t3nightly | ssh <host> tar -x -C t3nightly/engine-<sha>`.

Source: moved from open-factory `engine/t3nightly` at 3c2abf5fe; the load-guard reader that came from `fleet.factory` now lives in `t3nightly/load_guard.py`.
