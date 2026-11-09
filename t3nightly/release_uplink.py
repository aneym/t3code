import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone

UPLINK_KBPS = 1000
WINDOW = "05:00-12:00"
UPLINK_NODES = frozenset({"M", "D", "SM", "SD", "W", "F"})
SPAN = re.compile(r"([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)")


def rsync_cap():
    return [f"--bwlimit={UPLINK_KBPS}"]


def scp_cap():
    return ["-l", str(UPLINK_KBPS * 8)]


def curl_cap():
    return ["--limit-rate", f"{UPLINK_KBPS}k"]


def remote_path(destination):
    host, separator, _ = str(destination).partition(":")
    return bool(separator) and "/" not in host


class Paced:
    def __init__(self, handle, kbps=UPLINK_KBPS):
        self.handle = handle
        self.rate = kbps * 1024
        self.sent = 0
        self.started = None

    def read(self, size=-1):
        if self.started is None:
            self.started = time.monotonic()
        chunk = self.handle.read(min(size, self.rate) if size and size > 0 else self.rate)
        self.sent += len(chunk)
        ahead = self.sent / self.rate - (time.monotonic() - self.started)
        if ahead > 0:
            time.sleep(ahead)
        return chunk

    def close(self):
        self.handle.close()


def parse_window(text):
    if text == "off":
        return None
    match = SPAN.fullmatch(text)
    if not match:
        raise ValueError("--uplink-window takes HH:MM-HH:MM in UTC, or off")
    start, end = int(match[1]) * 60 + int(match[2]), int(match[3]) * 60 + int(match[4])
    if start == end:
        raise ValueError("--uplink-window needs a nonempty span; use off to disable it")
    return start, end


def window_open(window, now):
    if window is None:
        return True
    start, end = window
    minute = now.hour * 60 + now.minute
    return start <= minute < end if start < end else minute >= start or minute < end


def next_open(window, now):
    if window_open(window, now):
        return now
    opening = now.replace(hour=window[0] // 60, minute=window[0] % 60, second=0, microsecond=0)
    return opening if opening > now else opening + timedelta(days=1)


def stamp(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class UplinkGate:
    def __init__(self, text, dry_run, held_seconds=0.0, out=sys.stdout):
        self.text = text
        self.window = parse_window(text)
        self.dry_run = dry_run
        self.out = out
        self.offset = timedelta()
        self.held = {}
        self.seconds = held_seconds
        self.mark = None
        self.settled = None

    def now(self):
        return datetime.now(timezone.utc) + self.offset

    def emit(self, **row):
        self.out.write(json.dumps({"uplinkWindow": self.text, "at": stamp(self.now()), **row}) + "\n")
        self.out.flush()

    def hold(self, node):
        if node.id not in UPLINK_NODES:
            return False
        now = self.now()
        if window_open(self.window, now):
            if self.held.pop(node.id, None):
                self.emit(node=node.id, released=True)
            return False
        if node.id not in self.held:
            self.held[node.id] = stamp(next_open(self.window, now))
            self.emit(node=node.id, deferredUntil=self.held[node.id], reason="bulk upload leaves Studio; outside the uplink window")
        return True

    def pause(self, running, settled):
        clock = time.monotonic()
        if self.held and self.mark is not None:
            self.seconds += clock - self.mark
        self.mark = clock
        idle, self.settled = not running and settled == self.settled, settled
        if self.held and not running:
            wait = (next_open(self.window, self.now()) - self.now()).total_seconds()
            if self.dry_run:
                if idle:
                    self.offset += timedelta(seconds=wait)
            else:
                time.sleep(max(0.2, min(60.0, wait)))
        elif running and not self.dry_run:
            time.sleep(0.2)
