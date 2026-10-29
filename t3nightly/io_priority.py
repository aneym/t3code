import sys


def background_command(words, *, system=None):
    prefix = ["taskpolicy", "-b"] if (system or sys.platform) == "darwin" else ["ionice", "-c3", "nice", "-n", "19"]
    return [*prefix, *words]
