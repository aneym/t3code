import json
import os
import urllib.parse
import urllib.request

DEFAULT_URL = "http://127.0.0.1:2455"


def health(opener, candidate):
    try:
        parsed = urllib.parse.urlsplit(candidate)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            return None
        url = candidate.rstrip("/")
        with opener.open(f"{url}/health", timeout=2) as response:
            value = json.loads(response.read(16384))
            if response.status != 200 or not isinstance(value, dict) or value.get("status") != "ok":
                return None
        identities = [value[key] for key in ("service", "name", "app") if key in value]
        identified = any(identity == "agent-lb" for identity in identities)
        if identities and not identified:
            return None
        return url, identified
    except (OSError, ValueError):
        return None


def agent_lb_url():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    configured = os.environ.get("AGENT_LB_URL") or os.environ.get("CLAUDE_LB_BASE_URL")
    if configured:
        result = health(opener, configured)
        if result:
            return result[0]
    fallback = None
    for candidate in (DEFAULT_URL, "http://127.0.0.1:2456"):
        result = health(opener, candidate)
        if result:
            if result[1]:
                return result[0]
            fallback = fallback or result[0]
    return fallback or DEFAULT_URL
