DEFAULT_PROPERTIES = {"CPUQuota": "200%", "CPUWeight": "20"}


def properties():
    return DEFAULT_PROPERTIES.copy()


def systemd_arguments():
    return [f"--property={key}={value}" for key, value in properties().items()]
