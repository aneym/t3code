# Pre-drain rollback copy (Linux restore-rollback installs)

A restore-rollback install keeps a local copy of `statev2.sqlite` so a failed candidate can be rolled back to the exact pre-stop state. This page covers how that copy is made on Linux without `--offbox`. Studio's at-stop APFS clone is unchanged.

## The base

The base is `<backups>/prestop-replica/statev2.sqlite` with an `at-stop.json` record. `seed()` reflinks the base, or failing that the newest complete kept copy, into the new version's directory. No live read happens at that step. The base only helps when it is recent. Before this change nothing refreshed it, so an install after a run of binary-rollback installs started from a base days old.

## Old path (`predrain-sqlite3-rsync`)

1. Seed from the base.
2. At the stop, while the server is down, `sqlite3_rsync` the live file into the seed.

The stopped cost is a hashing floor plus the changed pages. On ax42 that was 81.5 s to hash 39 GB, then about 3.8k pages/s. A day-old base (1.2M changed pages) gave a 330 s stop window.

## New path (`pinned-file-sync`)

1. **Room check.** Before seeding, `install_disk_room` projects the fill level after the copy using the disk-watch rules: warn at 85% used with under 100 GiB free, critical at 93% or under 40 GiB free on `/`. A copy of 1 GiB or more that would cross a line is refused up front, with nothing copied and nothing stopped. Reflink support is probed with `cp --reflink=always`. Without it, a base on the same device is moved instead of copied, and it is moved back if the install fails.
2. **Pin.** While the old server runs, a separate child process (`install_live_sync pin`) opens the live database read-only and holds one read transaction. With that read mark held, checkpoints cannot backfill past it and the WAL cannot restart. The pin must be its own process: closing any descriptor on the `-shm` drops every POSIX lock the process holds on that file, and the installer opens the `-shm` to measure the WAL. The first build held the pin in-process and produced copies that failed `integrity_check` under live writes.
3. **File sync.** An idle-priority child (ionice class 3, nice 19) reads the live database file with `O_DIRECT` in 1 MiB chunks, compares each chunk to the copy, and writes only the 4 KiB pages that differ. Reads are paced to 160 MiB/s across both files. Writes are paced to the free space divided by 4 hours, so the disk-watch fill-time projection stays quiet. Each page the copy holds is either the base version or a version at or before the pin, and every page that changed since the base is in the pinned WAL.
4. **Watch.** The pin is dropped if the WAL in use reaches `live_read_guard.headroom_limit` or the pin passes one hour. Writers are never blocked; only the WAL grows.
5. **At the stop.** Copy the `-wal` into the copy. The WAL's size, mtime and in-use frames must be unchanged across the copy. Then release the pin, replay the WAL into the copy (TRUNCATE checkpoint) and compare identity. `quick_check` and sha256 run after the new server starts, as before.
6. **Fallback.** If the pin was lost or the WAL copy failed, the stop runs the old `sqlite3_rsync` delta. The file sync has already brought the copy close, so that delta is short.

Restore is unchanged (`install_predrain.restore`).

## Refreshing the base ahead of an install

`install --refresh-base` brings the base up to the live database while the server runs: the same pin, file sync and live WAL copy, then a replay, identity, `quick_check`, and a fresh `at-stop.json`. It installs nothing, stops nothing, and takes the base lock (`<backups>/prestop-replica.lock`). A seed or another refresh holding that lock is skipped, not waited on. If a refresh dies part way, it leaves the base unmarked and the next install seeds from the newest kept copy.

For Factory, run this shortly before a restore-rollback install on that host, never during one, using the engine and `--backups` value the install will use:

```
python3 -I ~/t3nightly/engine-<sha>/t3nightly/install --refresh-base --home ~/.t3 --backups <the install's --backups path>
```

`--backups` must not contain a symlink (same rule as installs), so pass the resolved path. `--refresh-read-mib-s` changes the read pace (default 160). It prints one JSON line per step; `base-refresh-done` carries the delta and checks.

## Measurements (ax42 sandbox, 2026-11-17)

Setup: a throwaway T3 home seeded from the t3-nightly seed through `migrate-dev-db --source`, padded to 1.6-1.75 GB with synthetic threads, and served by a sandbox `t3 serve` (aneym.100). Load was a Replay turn loop plus a 10 Hz write-and-read probe. The base was a stale copy taken before 15,000 message-row updates.

Install copy-and-stop path through `install_backup.capture`:

| Run | Stop window | Copy while stopped | Total copy | Extra disk | Probe write p95 during the online copy |
| --- | --- | --- | --- | --- | --- |
| Before: `sqlite3_rsync` at the stop | 14.5 s | 11.0 s (74.5k pages) | 11.7 s | 1.42 GB | none (all stopped) |
| After: pinned sync | 2.9 s | 0.66 s (113 MB WAL) | 64.8 s | 0.30 GB | 12.1 ms (baseline 10.6) |
| After `--refresh-base` (43 s, online) | 2.7 s | 0.50 s | 23.8 s | 0.14 GB | not measured |
| Pin lost on purpose (fallback) | 6.2 s | 3.9 s (2.8k pages) | 76.9 s | 1.24 GB | not measured |

All copies passed `integrity_check`. A rollback from the refreshed-base copy restored in 6.7 s with matching identity.

Online methods compared on the same database, under the same load:

| Method | Time | Written | Probe write p95 (baseline) | Notes |
| --- | --- | --- | --- | --- |
| backup API, paced to 32 MiB/s | 53 s | 1.71 GB | 16.2 ms (11.8) | full copy every time; no delta |
| `VACUUM INTO` | 14 s | 1.63 GB | 18.6 ms (19.7) | full copy; new page layout, so no WAL replay or rsync delta |
| `sqlite3_rsync` online | 11 s | 0.57 GB | 11.2 ms (18.5) | holds a read for the whole run; hashing floor on large files |
| pinned file sync | 55 s | 0.27 GB of pages | 11.7 ms (19.2) | one 322 ms max; pages only, then WAL replay |

The pinned file sync is gentlest on writes and disk, and it is the only method that leaves a page-identical copy the stopped WAL can finish. On XFS, scattered 4 KiB writes into a reflinked base unshare larger extents, so the extra disk is above the pages written (0.30 GB for 75k pages here).

On a 39 GB database at 160 MiB/s, the online sync should take about 8 minutes. The stop then holds only the WAL copy and replay, which is bounded by the headroom limit. These are projections; this path has not run on a live install.
