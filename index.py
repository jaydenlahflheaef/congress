"""Vercel entrypoint.

Vercel looks for a FastAPI instance named ``app`` in a root-level index.py.
This file only puts backend/ on the import path and re-exports the app
defined in backend/app/main.py, so local runs and Vercel use the same code.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

from app.main import app  # noqa: E402,F401
