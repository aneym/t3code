import shutil
from pathlib import Path

from .snapshot_space import database_bytes

FLOOR = 40 * 1024**3


def live_database(home):
    return Path(home).absolute() / "userdata/statev2.sqlite"


def on_live_volume(path, home):
    return Path(path).stat().st_dev == live_database(home).parent.stat().st_dev


def room(directory, home, clones):
    size = database_bytes(live_database(home))
    free = shutil.disk_usage(directory).free
    required = FLOOR + size * clones
    return {"directory": str(directory), "freeBytes": free, "floorBytes": FLOOR, "databaseBytes": size, "clones": clones, "requiredBytes": required, "passes": free >= required}
