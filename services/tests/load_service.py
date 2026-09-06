"""Helper for tests that need to import a service's top-level file (e.g.
"api_gateway/main.py") which normally only runs inside its own container.

Each service does `sys.path.insert(0, "/app/common")` then plain top-level
imports (`from audit import log_event`, `from pubsub_client import ...`).
Those resolve fine under test because conftest.py already put
services/common on sys.path -- so we just need to load the service file
itself as a module, without it being importable via a package path.
"""
import importlib.util
import os
import sys

SERVICES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def load_module(module_name: str, relative_path: str):
    """Load services/<relative_path> as a module named `module_name`.

    Re-loads (and re-execs) on every call rather than reusing a cached
    sys.modules entry, so each test starts from a fresh copy of the
    service's module-level state.
    """
    file_path = os.path.join(SERVICES_DIR, relative_path)
    service_dir = os.path.dirname(file_path)
    if service_dir not in sys.path:
        sys.path.insert(0, service_dir)  # so e.g. orchestrator.py's `from lyzr_client import ...` resolves
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module
