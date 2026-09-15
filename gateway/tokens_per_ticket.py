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
- With the plugin on, ticket tags come only from the registry. A request that
  sets its own `ticket:` tag (header or body) is rejected with a clear error,
  so a key can't charge its spend to an arbitrary ticket.
- Pass-through routes (/anthropic/*, /vertex_ai/*, ...) hand this hook no
  request headers, and LiteLLM merges their x-litellm-tags only after it runs,
  so a ticket claim there can't be checked. With the registry on, the plugin
  refuses pass-through calls unless TPT_ALLOW_PASS_THROUGH=true (for a shared
  gateway that serves product traffic that way; restrict developer keys with
  allowed_routes then). Claude Code uses /v1/messages, not pass-through.
- LiteLLM records spend tags from a copy of the request metadata held by its
  logging object (`model_call_details.litellm_params`), taken before plugins
  run, and prefers it over the request's own metadata (checked on v1.100.1,
  litellm_logging.py `_get_request_tags`). The plugin updates both.
- The registry record must have been reported by the key making the call.
  Hooks never send the key: they send sha256(sha256(key)), and LiteLLM knows
  the key as sha256(key) (`user_api_key_dict.token`), so one more round here
  gives the same fingerprint.
- A subagent's own record wins over its session's, so a subagent working in
  another worktree doesn't move the parent session's spend.
- Apart from that rejection, it never blocks a model call. Registry errors mean "no tag", and after one
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
        self.allow_pass_through = os.environ.get("TPT_ALLOW_PASS_THROUGH", "").lower() in ("1", "true", "yes")
        self._cache: dict[str, tuple[float, dict | None]] = {}
        self._skip_until = 0.0
        self._client: httpx.AsyncClient | None = None

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if self.registry_url and self.registry_token and call_type == "pass_through_endpoint" and not self.allow_pass_through:
            return (
                "tokens-per-ticket: pass-through routes are off on this gateway because their spend tags can't be verified. "
                "Use /v1/messages (as Claude Code does), or set TPT_ALLOW_PASS_THROUGH=true and restrict developer keys with allowed_routes."
            )
        if self.registry_url and self.registry_token and self._client_ticket_tags(data):
            # Keep the refused request from being logged under the claimed ticket.
            for tags in self._tag_lists(data):
                tags[:] = [tag for tag in tags if not self._is_ticket_tag(tag)]
            # A string return makes LiteLLM refuse the request with this message.
            return (
                f"tokens-per-ticket: '{self.tag_prefix}' tags are set by the gateway from the session registry. "
                "Remove them from x-litellm-tags or the request body; the ticket follows your branch automatically."
            )
        try:
            await self._tag(user_api_key_dict, data)
        except Exception as error:  # never fail a model call over attribution
            self._skip_until = time.monotonic() + self.backoff_seconds
            verbose_proxy_logger.warning("tokens_per_ticket: registry unavailable, skipping for %ss: %s", self.backoff_seconds, error)
        return data

    def _client_ticket_tags(self, data: dict) -> list:
        """Ticket tags the caller supplied: in the x-litellm-tags header or in body tags."""
        found = []
        headers = (data.get("proxy_server_request") or {}).get("headers") or {}
        for name, value in headers.items():
            if str(name).lower() == "x-litellm-tags":
                parts = value.split(",") if isinstance(value, str) else list(value or [])
                found += [p.strip() for p in parts if isinstance(p, str) and self._is_ticket_tag(p.strip())]
        for key in ("metadata", "litellm_metadata"):
            metadata = data.get(key)
            if isinstance(metadata, dict):
                found += [t for t in (metadata.get("tags") or []) if self._is_ticket_tag(t)]
        found += [t for t in (data.get("tags") or []) if self._is_ticket_tag(t)] if isinstance(data.get("tags"), list) else []
        return found

    async def _tag(self, user_api_key_dict, data: dict) -> None:
        if not self.registry_url or not self.registry_token:
            return
        headers = {str(k).lower(): v for k, v in ((data.get("proxy_server_request") or {}).get("headers") or {}).items()}
        session_id = headers.get(SESSION_HEADER)
        if not session_id or time.monotonic() < self._skip_until:
            return

        session = await self._lookup(session_id, headers.get(AGENT_HEADER))
        if not session or not session.get("ticket"):
            return
        token = getattr(user_api_key_dict, "token", None)
        if not token or session.get("key_fingerprint") != hashlib.sha256(token.encode()).hexdigest():
            return

        ticket_tag = f"{self.tag_prefix}{session['ticket']}"
        metadata_key = "litellm_metadata" if isinstance(data.get("litellm_metadata"), dict) else "metadata"
        metadata = data.setdefault(metadata_key, {})
        if not isinstance(metadata.get("tags"), list):
            metadata["tags"] = []
        for tags in self._tag_lists(data):
            if ticket_tag not in tags:
                tags.append(ticket_tag)

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

    def _is_ticket_tag(self, tag) -> bool:
        return isinstance(tag, str) and tag.startswith(self.tag_prefix)

    def _strip_ticket_header(self, headers: dict) -> None:
        for name in [k for k in headers if str(k).lower() == "x-litellm-tags"]:
            value = headers[name]
            parts = value.split(",") if isinstance(value, str) else list(value or [])
            kept = [p.strip() for p in parts if isinstance(p, str) and p.strip() and not self._is_ticket_tag(p.strip())]
            if kept:
                headers[name] = ",".join(kept) if isinstance(value, str) else kept
            else:
                del headers[name]

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
