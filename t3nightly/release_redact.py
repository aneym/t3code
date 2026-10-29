import os
import sys


values = sorted(
    {os.environ[key] for key in ("APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_API_KEY", "CSC_KEY_PASSWORD") if os.environ.get(key)},
    key=len,
    reverse=True,
)
for line in sys.stdin:
    for value in values:
        line = line.replace(value, "[redacted]")
    sys.stdout.write(line)
    sys.stdout.flush()
