"""
tokens-per-ticket gateway plugin: tag each Claude Code call with its ticket.

Claude Code sends `x-claude-code-session-id` on every request
(https://code.claude.com/docs/en/llm-gateway-protocol). The project's hooks
report which ticket each session is on to the session registry. This pre-call
hook looks the session up and adds `ticket:<KEY>` to the request's tags, which
LiteLLM writes to LiteLLM_DailyTagSpend like any other tag. Everything that
reads per-tag spend (the ledger, reports, LiteLLM's own tag reports) works
unchanged. Subagents share their session's id, so they count toward its ticket.

Rules:
- Only the registry sets tickets. A request that sets its own `ticket:` tag
  (header or body) is refused with a clear error, even while the registry
  settings are missing. A key can
  still report its own session on any ticket, as it could by naming a branch:
  attribution is for visibility, not billing enforcement.
- Pass-through routes (/anthropic/*, /vertex_ai/*, ...) give this hook no
  request headers, and LiteLLM applies their tag headers after it runs, so a
  ticket claim there can't be checked. They're refused unless
  TPT_ALLOW_PASS_THROUGH=true (for a gateway that also serves product traffic
  that way; then restrict developer keys with allowed_routes). Claude Code
  uses /v1/messages.
- The session must have been reported by the key making the call: the
  registry stores sha256(key) of the reporting key, the same form LiteLLM
  gives this hook as `user_api_key_dict.token`.
- LiteLLM records spend tags from its logging object's copy of the request
  metadata (`model_call_details.litellm_params`), taken before plugins run and
  preferred over the request's own (v1.100.1, litellm_logging.py
  `_get_request_tags`). The plugin updates both.
- Otherwise it never blocks a call. Registry trouble means "no tag": after a
  few failures in a row it skips new lookups briefly, and keeps serving
  sessions it already knows.

Loaded with `litellm_settings.callbacks: tokens_per_ticket.proxy_handler_instance`
(https://docs.litellm.ai/docs/proxy/call_hooks). LiteLLM checks tag *budgets*
during auth, before this hook, so they don't see these tags.
"""

import os
import re
import time
from urllib.parse import quote

import httpx
from litellm._logging import verbose_proxy_logger
from litellm.integrations.custom_logger import CustomLogger

SESSION_HEADER = "x-claude-code-session-id"
# The registry accepts the same shape (registry/src/server.mjs). Anything else
# is never looked up, so a junk header can't make the registry look unhealthy.
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
TAGS_HEADER = "x-litellm-tags"
# Fixed, matching src/lib/contract.ts TAG_PREFIX.
TAG_PREFIX = "ticket:"


class SessionTicketTagger(CustomLogger):
    def __init__(self) -> None:
        super().__init__()
        self.registry_url = os.environ.get("TPT_REGISTRY_URL", "").rstrip("/")
        self.registry_token = os.environ.get("TPT_REGISTRY_TOKEN", "")
        self.tag_prefix = TAG_PREFIX
        self.allow_pass_through = os.environ.get("TPT_ALLOW_PASS_THROUGH", "").lower() in ("1", "true", "yes")
        # A branch switch shows up within this many seconds.
        self.cache_seconds = float(os.environ.get("TPT_CACHE_SECONDS", "2"))
        self.timeout = float(os.environ.get("TPT_TIMEOUT_SECONDS", "0.3"))
        # After this many failed lookups in a row, skip new lookups for a while.
        self.failures_before_backoff = int(os.environ.get("TPT_FAILURES_BEFORE_BACKOFF", "3"))
        self.backoff_seconds = float(os.environ.get("TPT_BACKOFF_SECONDS", "15"))
        self._cache: dict[str, tuple[float, dict | None]] = {}
        self._failures = 0
        self._skip_until = 0.0
        self._client: httpx.AsyncClient | None = None

        if not self.enabled:
            verbose_proxy_logger.error(
                "tokens_per_ticket: TPT_REGISTRY_URL and TPT_REGISTRY_TOKEN aren't both set, so no call is tagged. Client ticket tags are still refused."
            )

    @property
    def enabled(self) -> bool:
        return bool(self.registry_url and self.registry_token)

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if call_type == "pass_through_endpoint" and not self.allow_pass_through:
            self._strip_ticket_tags(data)
            return (
                "tokens-per-ticket: pass-through routes are off on this gateway because their spend tags can't be verified. "
                "Use /v1/messages (as Claude Code does), or set TPT_ALLOW_PASS_THROUGH=true and restrict developer keys with allowed_routes."
            )
        if self._client_ticket_tags(data):
            # Keep the refused request from being logged under the claimed ticket.
            self._strip_ticket_tags(data)
            # A string return makes LiteLLM refuse the request with this message.
            return (
                f"tokens-per-ticket: '{self.tag_prefix}' tags are set by the gateway from the session registry. "
                "Remove them from x-litellm-tags or the request body; the ticket follows your branch automatically."
            )
        if not self.enabled:
            return data
        try:
            await self._tag(user_api_key_dict, data)
        except Exception as error:  # never fail a model call over attribution
            verbose_proxy_logger.warning("tokens_per_ticket: skipped tagging: %s", error)
        return data

    async def _tag(self, user_api_key_dict, data: dict) -> None:
        headers = {str(k).lower(): v for k, v in ((data.get("proxy_server_request") or {}).get("headers") or {}).items()}
        session_id = headers.get(SESSION_HEADER)
        if not isinstance(session_id, str) or not SESSION_ID.match(session_id):
            return
        session = await self._lookup(session_id)
        if not session or not session.get("ticket"):
            return
        token = getattr(user_api_key_dict, "token", None)
        if not token or session.get("key_token") != token:
            return

        ticket_tag = f"{self.tag_prefix}{session['ticket']}"
        metadata_key = "litellm_metadata" if isinstance(data.get("litellm_metadata"), dict) else "metadata"
        metadata = data.setdefault(metadata_key, {})
        if not isinstance(metadata.get("tags"), list):
            metadata["tags"] = []
        for tags in self._tag_lists(data):
            if ticket_tag not in tags:
                tags.append(ticket_tag)

    def _strip_ticket_tags(self, data: dict) -> None:
        for tags in self._tag_lists(data):
            tags[:] = [tag for tag in tags if not self._is_ticket_tag(tag)]

    def _is_ticket_tag(self, tag) -> bool:
        # LiteLLM trims header tags but not body tags; compare the way people read them.
        return isinstance(tag, str) and tag.strip().lower().startswith(self.tag_prefix.lower())

    def _client_ticket_tags(self, data: dict) -> list:
        """Ticket tags the caller supplied: in the x-litellm-tags header or in body tags."""
        found = []
        headers = (data.get("proxy_server_request") or {}).get("headers") or {}
        for name, value in headers.items():
            if str(name).lower() == TAGS_HEADER:
                parts = value.split(",") if isinstance(value, str) else list(value or [])
                found += [p for p in parts if self._is_ticket_tag(p)]
        for holder in (data.get("metadata"), data.get("litellm_metadata"), data):
            if isinstance(holder, dict) and isinstance(holder.get("tags"), list):
                found += [t for t in holder["tags"] if self._is_ticket_tag(t)]
        return found

    def _tag_lists(self, data: dict) -> list:
        """Every tag list LiteLLM reads spend tags from: the request's and the logging copy's."""
        holders = [data.get("metadata"), data.get("litellm_metadata")]
        details = getattr(data.get("litellm_logging_obj"), "model_call_details", None)
        params = details.get("litellm_params") if isinstance(details, dict) else None
        if isinstance(params, dict):
            holders += [params.get("metadata"), params.get("litellm_metadata")]
        lists = []
        for holder in holders:
            if isinstance(holder, dict) and isinstance(holder.get("tags"), list) and not any(holder["tags"] is seen for seen in lists):
                lists.append(holder["tags"])
        return lists

    async def _lookup(self, session_id: str) -> dict | None:
        now = time.monotonic()
        hit = self._cache.get(session_id)
        if hit and (hit[0] > now or now < self._skip_until):
            return hit[1]
        if now < self._skip_until:
            return None

        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        try:
            response = await self._client.get(
                f"{self.registry_url}/v1/sessions/{quote(session_id, safe='')}",
                headers={"Authorization": f"Bearer {self.registry_token}"},
            )
        except Exception:
            self._failures += 1
            if self._failures >= self.failures_before_backoff:
                self._skip_until = now + self.backoff_seconds
                self._failures = 0
            raise
        # 404 is "unknown session". Anything else (a wrong TPT_REGISTRY_TOKEN
        # answers 401) is a registry problem: log it and back off.
        if response.status_code not in (200, 404):
            self._failures += 1
            if self._failures >= self.failures_before_backoff:
                self._skip_until = now + self.backoff_seconds
                self._failures = 0
            raise RuntimeError(f"registry returned {response.status_code}")
        self._failures = 0
        session = response.json() if response.status_code == 200 else None

        self._cache[session_id] = (now + self.cache_seconds, session)
        if len(self._cache) > 10_000:
            self._cache = {k: v for k, v in self._cache.items() if v[0] > now}
        return session


proxy_handler_instance = SessionTicketTagger()
