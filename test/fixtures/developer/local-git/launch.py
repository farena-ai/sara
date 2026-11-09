"""Qualification entrypoint: record own identity, then run unchanged upstream."""
import json
import os
from pathlib import Path
import runpy
import sys
import time

Path(os.environ['LOCAL_GIT_IDENTITY']).write_text(json.dumps({'pid': os.getpid(), 'started': time.time(), 'executable': sys.executable}))
runpy.run_module('mcp_server_git', run_name='__main__')
