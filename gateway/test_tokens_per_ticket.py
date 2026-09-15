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

    def test_refuses_a_request_that_sets_its_own_ticket_tag(self):
        records = {("s1", None): {"ticket": "ENG-1", "key_fingerprint": self.jane_fp}}
        for data in (
            request(tags=["ticket:ENG-999"]),
            {**request(), "proxy_server_request": {"headers": {"X-LiteLLM-Tags": "team:web, ticket:ENG-999"}}},
            {**request(), "tags": ["ticket:ENG-999"]},
        ):
            self.plugin._client = _Client(records)
            result = asyncio.run(self.plugin.async_pre_call_hook(_Key(self.jane_token), None, data, "anthropic_messages"))
            self.assertIsInstance(result, str)
            self.assertIn("set by the gateway", result)

    def test_other_client_tags_are_fine(self):
        tags, _ = self.run_hook(self.jane_token, request(tags=["team:web"]), {("s1", None): {"ticket": "ENG-1", "key_fingerprint": self.jane_fp}})
        self.assertEqual(tags, ["team:web", "ticket:ENG-1"])

    def test_tags_the_logging_copy_litellm_records_spend_from(self):
        data = request(tags=["team:web"])
        logging_obj = types.SimpleNamespace(model_call_details={"litellm_params": {"metadata": {"tags": ["team:web"]}, "litellm_metadata": {"tags": ["team:web"]}}})
        data["litellm_logging_obj"] = logging_obj
        self.run_hook(self.jane_token, data, {("s1", None): {"ticket": "ENG-1", "key_fingerprint": self.jane_fp}})
        params = logging_obj.model_call_details["litellm_params"]
        self.assertEqual(params["metadata"]["tags"], ["team:web", "ticket:ENG-1"])
        self.assertEqual(params["litellm_metadata"]["tags"], ["team:web", "ticket:ENG-1"])

    def test_a_refused_request_is_not_logged_under_the_claimed_ticket(self):
        data = request(tags=["ticket:ENG-999"])
        logging_obj = types.SimpleNamespace(model_call_details={"litellm_params": {"metadata": {"tags": ["ticket:ENG-999", "team:web"]}}})
        data["litellm_logging_obj"] = logging_obj
        self.plugin._client = _Client({})
        result = asyncio.run(self.plugin.async_pre_call_hook(_Key(self.jane_token), None, data, "anthropic_messages"))
        self.assertIsInstance(result, str)
        self.assertEqual(logging_obj.model_call_details["litellm_params"]["metadata"]["tags"], ["team:web"])

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
        tags, first = self.run_hook(self.jane_token, request(), {}, fail=True)
        self.assertEqual((tags, first.calls), ([], 1))
        _, second = self.run_hook(self.jane_token, request(), {}, fail=True)
        self.assertEqual(second.calls, 0)


if __name__ == "__main__":
    unittest.main()
