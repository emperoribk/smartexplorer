"""Entry point Electron spawns. Reads the port from argv (default 8765) so
Electron can pick a free one and hand it to us, avoiding clashes with
anything else running locally.
"""
import os
import sys

# The bundled Windows runtime is an embeddable Python, which does not add this
# script's folder to sys.path. Do it explicitly so "app.main" always imports.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="info")
