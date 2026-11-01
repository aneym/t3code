import time


def wait_for(fn, seconds, what):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(0.25)
    raise TimeoutError(f"timed out waiting for {what}")
