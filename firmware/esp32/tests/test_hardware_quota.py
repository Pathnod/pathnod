"""Offline tests for trial verdicts, not for Bluetooth or cryptography."""
import asyncio
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


class FakeBleakError(Exception):
    pass


class QuotaHarnessTests(unittest.TestCase):
    def run_trial(self, *, reconnect_seconds=1, reject_31=True):
        state = {"connections": 0, "time": 0}

        class Client:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                state["connections"] += 1
                state["time"] += reconnect_seconds
                return self

            async def __aexit__(self, *args):
                pass

            async def write_gatt_char(self, *args, **kwargs):
                if reject_31 and state["connections"] == 31:
                    raise FakeBleakError("ATT unlikely error")

            async def read_gatt_char(self, uuid):
                if uuid.endswith("0002"):
                    return bytes(34) + bytes.fromhex("0000000a") + bytes(32)
                counter = min(state["connections"], 31)
                return bytes(72) + counter.to_bytes(4, "big") + bytes(2)

        async def sleep(seconds):
            state["time"] += seconds

        bleak = types.ModuleType("bleak")
        bleak.BleakClient = Client
        errors = types.ModuleType("bleak.exc")
        errors.BleakError = FakeBleakError
        spec = importlib.util.spec_from_file_location("quota_trial", Path(__file__).with_name("hardware_quota.py"))
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"bleak": bleak, "bleak.exc": errors}):
            spec.loader.exec_module(module)
        with patch.object(module.time, "monotonic", side_effect=lambda: state["time"]), \
             patch.object(module.asyncio, "sleep", side_effect=sleep), \
             patch.object(module.subprocess, "run"):
            return asyncio.run(module.trial("test-device"))

    def test_rejection_and_recovery(self):
        result = self.run_trial()
        self.assertEqual(result["result"], "expected rejection and recovery observed")
        self.assertEqual(len(result["attempts"]), 31)
        self.assertEqual(result["recovery_counter"], 31)

    def test_slow_reconnect_is_inconclusive(self):
        self.assertEqual(self.run_trial(reconnect_seconds=3)["result"], "inconclusive")

    def test_accepted_31st_write_is_failure(self):
        with self.assertRaisesRegex(RuntimeError, "31st fresh challenge"):
            self.run_trial(reject_31=False)


if __name__ == "__main__":
    unittest.main()
