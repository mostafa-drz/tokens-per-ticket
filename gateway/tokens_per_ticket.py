"""
tokens-per-ticket gateway plugin: tag each Claude Code call with its ticket.

Claude Code sends `x-claude-code-session-id` on every request
(https://code.claude.com/docs/en/llm-gateway-protocol). The project's hooks
report which ticket each session is on to the session registry. This
pre-call hook looks the session up and adds `ticket:<KEY>` to the request's
metadata tags, which LiteLLM writes to LiteLLM_DailyTagSpend like any other
tag. Everything that reads per-tag spend (the ledger, ticket:report, LiteLLM's
own tag reports) works unchanged.

Rules:
- A request that already carries a ticket tag (for example from
  `ticket:start`, which sets x-litellm-tags) keeps it. Explicit beats automatic.
- The session must have been reported with the same gateway key that makes
  the call, so nobody can re-point a colleague's session at another ticket.
- It never blocks a model call: registry errors or slowness mean "no tag".

Loaded with `litellm_settings.callbacks: tokens_per_ticket.proxy_handler_instance`
(https://docs.litellm.ai/docs/proxy/call_hooks). Tags added here are not seen
by LiteLLM's tag *budget* check, which runs earlier during auth; spend
tracking is unaffected.
"""

import os
import time

import httpx
from litellm._logging import verbose_proxy_logger
from litellm.integrations.custom_logger import CustomLogger

SESSION_HEADER = "x-claude-code-session-id"


class SessionTicketTagger(CustomLogger):
    def __init__(self) -> None:
        super().__init__()
        self.registry_url = os.environ.get("TPT_REGISTRY_URL", "").rstrip("/")
        self.registry_token = os.environ.get("TPT_REGISTRY_TOKEN", "")
        self.tag_prefix = os.environ.get("TPT_TAG_PREFIX", "ticket:")
        # Short cache: a branch switch shows up within this many seconds.
        self.cache_seconds = float(os.environ.get("TPT_CACHE_SECONDS", "2"))
        self.timeout = float(os.environ.get("TPT_TIMEOUT_SECONDS", "0.3"))
        self._cache: dict[str, tuple[float, dict | None]] = {}
        self._client: httpx.AsyncClient | None = None

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            await self._tag(user_api_key_dict, data)
        except Exception as error:  # never fail a model call over attribution
            verbose_proxy_logger.warning("tokens_per_ticket: skipped tagging: %s", error)
        return data

    async def _tag(self, user_api_key_dict, data: dict) -> None:
        if not self.registry_url or not self.registry_token:
            return
        headers = (data.get("proxy_server_request") or {}).get("headers") or {}
        session_id = next((v for k, v in headers.items() if k.lower() == SESSION_HEADER), None)
        if not session_id:
            return

        metadata_key = "litellm_metadata" if isinstance(data.get("litellm_metadata"), dict) else "metadata"
        metadata = data.setdefault(metadata_key, {})
        tags = list(metadata.get("tags") or [])
        if any(isinstance(tag, str) and tag.startswith(self.tag_prefix) for tag in tags):
            return

        session = await self._lookup(session_id)
        if not session or not session.get("ticket"):
            return
        if session.get("key_token") != getattr(user_api_key_dict, "token", None):
            return

        metadata["tags"] = tags + [f"{self.tag_prefix}{session['ticket']}"]

    async def _lookup(self, session_id: str) -> dict | None:
        now = time.monotonic()
        hit = self._cache.get(session_id)
        if hit and hit[0] > now:
            return hit[1]

        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        response = await self._client.get(
            f"{self.registry_url}/v1/sessions/{session_id}",
            headers={"Authorization": f"Bearer {self.registry_token}"},
        )
        session = response.json() if response.status_code == 200 else None
        if response.status_code not in (200, 404):
            raise RuntimeError(f"registry returned {response.status_code}")

        self._cache[session_id] = (now + self.cache_seconds, session)
        if len(self._cache) > 10_000:
            self._cache = {k: v for k, v in self._cache.items() if v[0] > now}
        return session


proxy_handler_instance = SessionTicketTagger()
