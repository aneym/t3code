import ctypes
import os
import subprocess
import sys


def clone_file(original, copy, timeout):
    if sys.platform != "darwin":
        subprocess.run(["cp", "--reflink=always", str(original), str(copy)], check=True, capture_output=True, timeout=min(10, timeout))
        return
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    libc.clonefile.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32)
    if libc.clonefile(os.fsencode(original), os.fsencode(copy), 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(original), None, str(copy))
