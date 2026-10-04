"""Development-board quota trial. Requires bleak; never flashes or erases NVS."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import subprocess
import time

from bleak import BleakClient
from bleak.exc import BleakError

INFO = "534f5645-4c00-0000-0000-000000000002"
CHALLENGE = "534f5645-4c00-0000-0000-000000000003"
RESPONSE = "534f5645-4c00-0000-0000-000000000004"
VERIFY = Path(__file__).with_name("verify_response.mjs")


async def trial(address):
    records = []
    public_key = None
    last_counter = 0
    first_attempt = None
    # Start with a board reset and no other clients to empty the RAM quota.
    for index in range(31):
        async with BleakClient(address, timeout=10) as client:
            info = bytes(await client.read_gatt_char(INFO))
            if len(info) != 70 or info[34:38] != bytes.fromhex("0000000a"):
                raise RuntimeError("Expected DEV-22 INFO layout/capabilities")
            if public_key is None:
                public_key = info[2:34]
            if public_key != info[2:34]:
                raise RuntimeError("Device identity changed")
            challenge = os.urandom(32) + bytes(12)
            started = time.monotonic()
            if first_attempt is None:
                first_attempt = started
            elapsed = started - first_attempt
            if elapsed >= 60:
                return {"result": "inconclusive", "reason": "31 reconnects did not fit inside 60 seconds", "attempts": records}
            rejected = False
            error_message = None
            try:
                await client.write_gatt_char(CHALLENGE, challenge, response=True)
            except BleakError as error:
                rejected = True
                error_message = str(error)
            record = {"attempt": index + 1, "elapsed_seconds": elapsed, "rejected": rejected, "error": error_message}
            records.append(record)
            if index < 30:
                if rejected:
                    raise RuntimeError(f"Unexpected rejection before global limit: {record}")
                response = bytes(await client.read_gatt_char(RESPONSE))
                subprocess.run(["node", str(VERIFY), public_key.hex(), challenge.hex(), response.hex()], check=True, capture_output=True)
                counter = int.from_bytes(response[72:76], "big")
                if counter <= last_counter:
                    raise RuntimeError("Counter did not increase")
                last_counter = counter
                record["counter"] = counter
            elif not rejected:
                raise RuntimeError("31st fresh challenge was accepted inside the rolling window")
            elif time.monotonic() - first_attempt >= 60:
                return {"result": "inconclusive", "reason": "31st write crossed the window boundary", "attempts": records}
    # A write error alone might be a transport fault. Confirm recovery with a
    # fresh connection after the entire original window has expired.
    await asyncio.sleep(max(0, first_attempt + 61 - time.monotonic()))
    async with BleakClient(address, timeout=10) as client:
        challenge = os.urandom(32) + bytes(12)
        await client.write_gatt_char(CHALLENGE, challenge, response=True)
        response = bytes(await client.read_gatt_char(RESPONSE))
        subprocess.run(["node", str(VERIFY), public_key.hex(), challenge.hex(), response.hex()], check=True, capture_output=True)
        counter = int.from_bytes(response[72:76], "big")
        if counter != last_counter + 1:
            raise RuntimeError("Rejected request unexpectedly consumed a counter, or another client interfered")
    return {"result": "expected rejection and recovery observed", "attempts": records, "recovery_counter": counter,
            "limit": "Inspect the recorded ATT error and board logs to distinguish quota rejection from transport failure."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("address", help="Bleak device address (CoreBluetooth UUID on macOS)")
    args = parser.parse_args()
    result = asyncio.run(trial(args.address))
    print(json.dumps(result, indent=2))
    if result["result"] == "inconclusive":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
