"""Sample module."""
import os


def top(a, b):
    return a + b


class Widget(Base):
    """A widget."""

    def __init__(self, name):
        self.name = name

    async def refresh(self):
        def inner():
            return 1
        return inner()


async def main():
    pass
