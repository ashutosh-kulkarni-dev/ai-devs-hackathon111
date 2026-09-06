"""Pytest configuration shared by every test under services/tests/.

Puts the canonical `common/` package on sys.path so tests can `import
schemas`, `import pubsub_client`, etc. exactly the way the services do
(they all do `sys.path.insert(0, "/app/common")` at runtime; here we point
at the on-disk copy instead of the container path).

services/common is the single canonical copy (plan_3.md Phase 6 collapsed
the three formerly-byte-identical api_gateway/orchestrator/agents copies
into this one), so testing against it exercises the same code every
container actually runs.
"""
import os
import sys

_COMMON_DIR = os.path.join(os.path.dirname(__file__), "..", "common")
sys.path.insert(0, os.path.abspath(_COMMON_DIR))
sys.path.insert(0, os.path.dirname(__file__))  # so tests can `import fake_pubsub`, `import load_service`
