def ssh_argv(host=None, *options, multiplex=True):
    words = ["ssh", "-o", "BatchMode=yes", "-o", "ControlMaster=auto" if multiplex else "ControlMaster=no",
             "-o", "ControlPath=~/.ssh/cm-%C" if multiplex else "ControlPath=none",
             "-o", "ControlPersist=120" if multiplex else "ControlPersist=no", *options]
    return words if host is None else [*words, host]
