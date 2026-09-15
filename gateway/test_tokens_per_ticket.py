"""
Tests for the gateway plugin, without a running LiteLLM.

    python3 -m unittest discover -s gateway -p "test_*.py"

LiteLLM and httpx are replaced with stand-ins, so this runs anywhere with
Python 3.10+. The live behavior was also checked on a v1.100.1 gateway.
"""

import asyncio
import hashlib
import sys
import types
import unittest


class _CustomLogger:
    def __init__(self, *args, **kwargs):
        pass


class _Logger:
    def warning(self, *args):
        pass


sys.modules.setdefault("litellm", types.ModuleType("litellm"))
logging_module = types.ModuleType("litellm._logging")
logging_module.verbose_proxy_logger = _Logger()
sys.modules["litellm._logging"] = logging_module
integrations = types.ModuleType("litellm.integrations")
custom_logger = types.ModuleType("litellm.integrations.custom_logger")
custom_logger.CustomLogger = _CustomLogger
sys.modules["litellm.integrations"] = integrations
sys.modules["litellm.integrations.custom_logger"] = custom_logger
sys.modules.setdefault("httpx", types.ModuleType("httpx"))

import os  # noqa: E402

os.environ.update({"TPT_REGISTRY_URL": "http://registry.test", "TPT_REGISTRY_TOKEN": "gw-secret"})

import tokens_per_ticket  # noqa: E402


def fingerprint(key: str) -> str:
    token = hashlib.sha256(key.encode()).hexdigest()
    return token, hashlib.sha256(token.encode()).hexdigest()


class _Response:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class _Client:
    def __init__(self, records, fail=False):
        self.records = records
        self.fail = fail
        self.calls = 0

    async def get(self, url, params=None, headers=None):
        self.calls += 1
        if self.fail:
            raise ConnectionError("registry down")
        session_id = url.rsplit("/", 1)[1]
        agent = (params or {}).get("agent_id")
        record = self.records.get((session_id, agent)) or self.records.get((session_id, None))
        return _Response(200, record) if record else _Response(404)


class _Key:
    def __init__(self, token):
        self.token = token


def request(session_id="s1", agent_id=None, tags=None):
    headers = {"X-Claude-Code-Session-Id": session_id}
    if agent_id:
        headers["x-claude-code-agent-id"] = agent_id
    return {"proxy_server_request": {"headers": headers}, "metadata": {"tags": list(tags or [])}}


class SessionTicketTaggerTest(unittest.TestCase):
    def setUp(self):
        self.jane_token, self.jane_fp = fingerprint("sk-jane")
        self.omar_token, _ = fingerprint("sk-omar")
        self.plugin = tokens_per_ticket.SessionTicketTagger()

    def run_hook(self, key_token, data, records, fail=False):
        client = _Client(records, fail)
        self.plugin._client = client
        result = asyncio.run(self.plugin.async_pre_call_hook(_Key(key_token), None, data, "anthropic_messages"))
        return result["metadata"]["tags"], client

    def test_tags_the_call_with_the_sessions_ticket(self):
        tags, _ = self.run_hook(self.jane_token, request(tags=["User-Agent: claude-cli"]), {("s1", None): {"ticket": "ENG-1", "key_fingerprint": self.jane_fp}})
        self.assertEqual(tags, ["User-Agent: claude-cli", "ticket:ENG-1"])

    def test_removes_ticket_tags_the_client_sent(self):
        records = {("s1", None): {"ticket": "ENG-1", "key_fingerprint": self.jane_fp}}
        tags, _ = self.run_hook(self.jane_token, request(tags=["ticket:ENG-999", "team:web"]), records)
        self.assertEqual(tags, ["team:web", "ticket:ENG-1"])
        tags, _ = self.run_hook(self.jane_token, request(session_id="unknown", tags=["ticket:ENG-999"]), records)
        self.assertEqual(tags, [])

    def test_another_keys_call_is_not_tagged(self):
        tags, _ = self.run_hook(self.omar_token, request(), {("s1", None): {"ticket": "ENG-1", "key_fingerprint": self.jane_fp}})
        self.assertEqual(tags, [])

    def test_a_subagents_own_record_wins_over_the_session(self):
        records = {
            ("s1", None): {"ticket": "ENG-1", "key_fingerprint": self.jane_fp},
            ("s1", "agent-7"): {"ticket": "ENG-2", "key_fingerprint": self.jane_fp},
        }
        tags, _ = self.run_hook(self.jane_token, request(agent_id="agent-7"), records)
        self.assertEqual(tags, ["ticket:ENG-2"])
        tags, _ = self.run_hook(self.jane_token, request(agent_id="agent-8"), records)
        self.assertEqual(tags, ["ticket:ENG-1"])

    def test_a_registry_outage_is_skipped_after_the_first_failure(self):
        data = request(tags=["ticket:ENG-999"])
        tags, first = self.run_hook(self.jane_token, data, {}, fail=True)
        self.assertEqual((tags, first.calls), ([], 1))
        _, second = self.run_hook(self.jane_token, request(), {}, fail=True)
        self.assertEqual(second.calls, 0)


if __name__ == "__main__":
    unittest.main()
