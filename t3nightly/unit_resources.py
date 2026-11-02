import socket


DEFAULT_PROPERTIES = {"CPUQuota": "200%", "CPUWeight": "20"}
HOST_OVERRIDES = {}


def properties(host=None):
    host = (host or socket.gethostname()).split(".", 1)[0]
    return DEFAULT_PROPERTIES | HOST_OVERRIDES.get(host, {})


def systemd_arguments():
    return [f"--property={key}={value}" for key, value in properties().items()]
