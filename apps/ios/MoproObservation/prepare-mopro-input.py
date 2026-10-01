#!/usr/bin/env python3
"""Convert the DEV-13 snarkjs input to Mopro's array-only Circom input format."""

import json
import sys
from pathlib import Path


def main() -> None:
    source, destination = map(Path, sys.argv[1:])
    values = json.loads(source.read_text())
    converted = {}
    for name, value in values.items():
        if isinstance(value, str):
            converted[name] = [value]
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            converted[name] = value
        else:
            raise ValueError(f"Unsupported Circom input shape for {name}")
    destination.write_text(json.dumps(converted, indent=2) + "\n")


if __name__ == "__main__":
    main()
