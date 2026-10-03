"""Reader and analysis tools for wtf.ai trip logs (docs/TRIP-LOGGER-SPEC.md §8)."""

from .reader import Trip, load

__all__ = ["Trip", "load"]
