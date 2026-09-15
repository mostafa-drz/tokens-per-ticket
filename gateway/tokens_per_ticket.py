"""
tokens-per-ticket gateway plugin: tag each Claude Code call with its ticket.

Claude Code sends `x-claude-code-session-id` on every request, and
`x-claude-code-agent-id` on requests from subagents
(https://code.claude.com/docs/en/llm-gateway-protocol). The project's hooks
report which ticket each session (and subagent) is on to the session
registry. This pre-call hook looks the call up and sets `ticket:<KEY>` on the
request's metadata tags, which LiteLLM writes to LiteLLM_DailyTagSpend like
any other tag. Everything that reads per-tag spend (the ledger, reports,
LiteLLM's own tag reports) works unchanged.

Rules:
- With the plugin on, ticket tags come only from the registry. Any
  `ticket:` tag a client sends is removed, so a key can't charge its spend to
  an arbitrary ticket by setting a header.
- The registry record must have been reported by the key making the call.
  Hooks never send the key: they send sha256(sha256(key)), and LiteLLM knows
  the key as sha256(key) (`user_api_key_dict.token`), so one more round here
  gives the same fingerprint.
- A subagent's own record wins over its session's, so a subagent working in
  another worktree doesn't move the parent session's spend.
- It never blocks a model call. Registry errors mean "no tag", and after one
  the registry is skipped for a short while so an outage doesn't add latency
  to every call.

Loaded with `litellm_settings.callbacks: tokens_per_ticket.proxy_handler_instance`
(https://docs.litellm.ai/docs/proxy/call_hooks). Tags added here are not seen
by LiteLLM's tag *budget* check, which runs earlier during auth; spend
tracking is unaffected.
"""

import hashlib
import os
import time
from urllib.parse import quote

import httpx
from litellm._logging import verbose_proxy_logger
from litellm.integrations.custom_logger import CustomLogger

SESSION_HEADER = "x-claude-code-session-id"
AGENT_HEADER = "x-claude-code-agent-id"


class SessionTicketTagger(CustomLogger):
    def __init__(self) -> None:
        super().__init__()
        self.registry_url = os.environ.get("TPT_REGISTRY_URL", "").rstrip("/")
        self.registry_token = os.environ.get("TPT_REGISTRY_TOKEN", "")
        self.tag_prefix = os.environ.get("TPT_TAG_PREFIX", "ticket:")
        # Short cache: a branch switch shows up within this many seconds.
        self.cache_seconds = float(os.environ.get("TPT_CACHE_SECONDS", "2"))
        self.timeout = float(os.environ.get("TPT_TIMEOUT_SECONDS", "0.3"))
        # After a registry error, skip lookups for this long.
        self.backoff_seconds = float(os.environ.get("TPT_BACKOFF_SECONDS", "15"))
        self._cache: dict[str, tuple[float, dict | None]] = {}
        self._skip_until = 0.0
        self._client: httpx.AsyncClient | None = None

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            await self._tag(user_api_key_dict, data)
        except Exception as error:  # never fail a model call over attribution
            self._skip_until = time.monotonic() + self.backoff_seconds
            verbose_proxy_logger.warning("tokens_per_ticket: registry unavailable, skipping for %ss: %s", self.backoff_seconds, error)
        return data

    async def _tag(self, user_api_key_dict, data: dict) -> None:
        if not self.registry_url or not self.registry_token:
            return

        metadata_key = "litellm_metadata" if isinstance(data.get("litellm_metadata"), dict) else "metadata"
        metadata = data.setdefault(metadata_key, {})
        # Only the registry decides tickets: drop client-supplied ticket tags.
        tags = [tag for tag in (metadata.get("tags") or []) if not (isinstance(tag, str) and tag.startswith(self.tag_prefix))]
        metadata["tags"] = tags

        headers = (data.get("proxy_server_request") or {}).get("headers") or {}
        lowered = {str(k).lower(): v for k, v in headers.items()}
        session_id = lowered.get(SESSION_HEADER)
        if not session_id or time.monotonic() < self._skip_until:
            return

        session = await self._lookup(session_id, lowered.get(AGENT_HEADER))
        if not session or not session.get("ticket"):
            return
        token = getattr(user_api_key_dict, "token", None)
        if not token or session.get("key_fingerprint") != hashlib.sha256(token.encode()).hexdigest():
            return

        metadata["tags"] = tags + [f"{self.tag_prefix}{session['ticket']}"]

    async def _lookup(self, session_id: str, agent_id: str | None) -> dict | None:
        cache_key = f"{session_id}\n{agent_id or ''}"
        now = time.monotonic()
        hit = self._cache.get(cache_key)
        if hit and hit[0] > now:
            return hit[1]

        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        url = f"{self.registry_url}/v1/sessions/{quote(session_id, safe='')}"
        response = await self._client.get(
            url,
            params={"agent_id": agent_id} if agent_id else None,
            headers={"Authorization": f"Bearer {self.registry_token}"},
        )
        if response.status_code not in (200, 404):
            raise RuntimeError(f"registry returned {response.status_code}")
        session = response.json() if response.status_code == 200 else None

        self._cache[cache_key] = (now + self.cache_seconds, session)
        if len(self._cache) > 10_000:
            self._cache = {k: v for k, v in self._cache.items() if v[0] > now}
        return session


proxy_handler_instance = SessionTicketTagger()
