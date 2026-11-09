"""PSFN Lite native Hermes plugin; loaded when memory.provider selects psfn_lite.

The name "MemoryProvider" in this file is how Hermes classifies the plugin
directory as a memory provider, loaded only through the memory slot.
"""

from . import runtime
from .provider import PsfnLiteProvider


def register(ctx) -> None:
    """Registers the MemoryProvider and, once per process, the lifecycle hooks and the hosted automata tool."""
    ctx.register_memory_provider(PsfnLiteProvider())
    runtime.register_hooks(ctx)
    runtime.register_tools(ctx)
