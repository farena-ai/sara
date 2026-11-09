"""A small client for Sara's HTTP API (no Home Assistant imports, so it can be tested alone).

It signs in with Sara's device-code flow (the same one the terminal client and the VS Code
extension use), then talks to Sara with the device token she issued:

* ``POST /api/device/start`` and ``POST /api/device/poll``: sign-in;
* ``GET /api/device/whoami``: who she is, whether the AI disclosure was accepted;
* ``POST /api/conversations`` and ``POST /api/conversations/<id>/messages``: a turn, read from
  the server-sent-events stream until she is done.

Her safety layer runs on the Sara server, unchanged: this client only shows what she sends
(including the AI disclosure and crisis notices, and replies her safety checks replaced).
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import aiohttp

DEVICE_TOKEN_PREFIX = "sara_dev."
USER_AGENT = "HomeAssistant-Sara/{version}"
CONVERSATION_TITLE = "Home Assistant"
# The limited access Home Assistant asks Sara for: it may only talk with her in the conversations it
# made itself (no other conversation, memory, file or setting). An app can only ask for less.
SCOPE = "home-assistant"


class SaraError(Exception):
    """Something went wrong talking to Sara."""


class SaraConnectionError(SaraError):
    """Sara couldn't be reached."""


class SaraAuthError(SaraError):
    """The device token isn't valid any more (signed out, expired, or never approved)."""


class SaraDisclosureError(SaraError):
    """The AI disclosure hasn't been accepted on this Sara server yet."""


def is_local_host(host: str) -> bool:
    """True for this machine and the home network: loopback, private and link-local addresses,
    'localhost', and names ending in .local (mDNS). Anything else gets https by default."""
    h = (host or "").strip().strip("[]").rstrip(".").lower()
    if not h:
        return False
    if h == "localhost" or h.endswith(".localhost") or h.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(h.split("%", 1)[0])
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def normalize_url(raw: str) -> str:
    """'sara.local:7860' -> 'http://sara.local:7860' (https unless it is local)."""
    s = (raw or "").strip()
    if not s:
        raise ValueError("empty address")
    if "://" not in s:
        host = urlsplit(f"//{s}").hostname or ""
        s = f"{'http' if is_local_host(host) else 'https'}://{s}"
    u = urlsplit(s)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("not an http(s) address")
    return f"{u.scheme}://{u.netloc}{u.path.rstrip('/')}"


@dataclass
class DeviceStart:
    """A device-code request: show ``code`` and ``verify_url``, then poll with ``poll_token``."""

    code: str
    poll_token: str
    verify_url: str
    approve_in: str
    interval: float
    expires_at: str


@dataclass
class SaraReply:
    """What she said in one turn."""

    text: str
    conversation_id: str
    notices: list[str] = field(default_factory=list)
    declined: list[str] = field(default_factory=list)
    replaced: bool = False
    error: str | None = None

    def speech(self) -> str:
        """Notices (the AI disclosure, crisis resources) first, then her reply."""
        parts = [n for n in self.notices if n]
        if self.text.strip():
            parts.append(self.text.strip())
        if self.declined:
            parts.append(
                "(She wanted to: "
                + "; ".join(self.declined)
                + ". Approvals aren't answered from Home Assistant: ask her in the Sara app.)"
            )
        if self.error and not self.text.strip():
            parts.append(f"(Sara: {self.error})")
        return "\n\n".join(parts)


_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\uFE0E\uFE0F\u200D\u20E3]"
)


def spoken(text: str) -> str:
    """Her reply as words a speaker can say (Assist voice satellites, Google Home and Nest speakers).

    Markdown marks, code blocks, link targets and emoji are left out; the words stay.
    """
    s = re.sub(r"```[\s\S]*?(```|$)", " (some code is in the Sara app) ", text)
    s = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"https?://([^\s/)]+)\S*", r"\1", s)
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"(?m)^\s{0,3}#{1,6}\s+", "", s)
    s = re.sub(r"(?m)^\s*[-*+•]\s+", "", s)
    s = re.sub(r"(\*\*|__|~~)(.+?)\1", r"\2", s)
    s = re.sub(r"(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)", r"\1", s)
    s = _EMOJI.sub("", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


async def sse_events(content: aiohttp.StreamReader) -> AsyncIterator[dict[str, Any]]:
    """Reads ``event:``/``data:`` blocks from a server-sent-events body."""
    data_lines: list[str] = []
    async for raw in content:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if line == "":
            if data_lines:
                try:
                    yield json.loads("\n".join(data_lines))
                except ValueError:
                    pass
                data_lines = []
            continue
        if line.startswith("data: "):
            data_lines.append(line[6:])
        elif line.startswith("data:"):
            data_lines.append(line[5:])
    if data_lines:
        try:
            yield json.loads("\n".join(data_lines))
        except ValueError:
            pass


class SaraClient:
    """Talks to one Sara server, as one signed-in device."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        url: str,
        token: str | None = None,
        *,
        companion: str | None = None,
        version: str = "0",
        timeout: float = 180,
    ) -> None:
        self._session = session
        self.url = normalize_url(url)
        self.token = token
        self.companion = companion
        self._ua = USER_AGENT.format(version=version)
        self._timeout = timeout

    # ---------- plumbing ----------
    def _headers(self, json_body: bool) -> dict[str, str]:
        h = {"user-agent": self._ua, "accept": "application/json"}
        if json_body:
            h["content-type"] = "application/json"
        if self.token:
            h["authorization"] = f"Bearer {self.token}"
        if self.companion:
            h["x-sara-companion"] = self.companion
        return h

    async def _request(self, method: str, path: str, body: Any = None, *, ok_statuses: tuple[int, ...] = ()) -> tuple[int, Any]:
        try:
            async with self._session.request(
                method,
                f"{self.url}/api{path}",
                headers=self._headers(body is not None),
                data=None if body is None else json.dumps(body),
                allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as res:
                text = await res.text()
                try:
                    data = json.loads(text) if text else {}
                except ValueError:
                    data = {}
                if res.status in ok_statuses:
                    return res.status, data
                self._raise_for(res.status, data)
                return res.status, data
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise SaraConnectionError(f"Couldn't reach Sara at {self.url}: {err}") from err

    @staticmethod
    def _raise_for(status: int, data: Any) -> None:
        if status < 400:
            return
        msg = data.get("error") if isinstance(data, dict) else None
        if status == 401:
            raise SaraAuthError(msg or "Not signed in (this device was signed out or its token expired).")
        if status == 403 and msg and "disclosure" in msg.lower():
            raise SaraDisclosureError(msg)
        raise SaraError(msg or f"HTTP {status}")

    # ---------- sign-in ----------
    async def health(self) -> bool:
        """True when a Sara server answers at this address."""
        _, data = await self._request("GET", "/health")
        return bool(isinstance(data, dict) and data.get("ok"))

    async def device_start(self, name: str = "Home Assistant") -> DeviceStart:
        _, d = await self._request("POST", "/device/start", {"name": name, "scope": SCOPE})
        return DeviceStart(
            code=str(d["code"]),
            poll_token=str(d["pollToken"]),
            verify_url=str(d.get("verifyUrl") or f"{self.url}/device"),
            approve_in=str(d.get("approveIn") or "Settings → Connections → Devices and sign-in"),
            interval=float(d.get("interval") or 2),
            expires_at=str(d.get("expiresAt") or ""),
        )

    async def device_poll(self, poll_token: str) -> tuple[str, str | None]:
        """('pending'|'approved'|'denied'|'expired', token when approved)."""
        status, d = await self._request("POST", "/device/poll", {"pollToken": poll_token}, ok_statuses=(410,))
        if status == 410:
            return "expired", None
        st = str(d.get("status", "pending"))
        tok = d.get("token") if st == "approved" else None
        if st == "approved" and not (isinstance(tok, str) and tok.startswith(DEVICE_TOKEN_PREFIX)):
            raise SaraError("Sara approved the sign-in but sent no device token.")
        return st, tok

    async def wait_for_approval(self, start: DeviceStart, *, max_wait: float = 600) -> tuple[str, str | None]:
        """Polls until the owner approves or denies, or the code expires."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max_wait
        while True:
            st, tok = await self.device_poll(start.poll_token)
            if st != "pending":
                return st, tok
            if loop.time() >= deadline:
                return "expired", None
            await asyncio.sleep(start.interval)

    async def whoami(self) -> dict[str, Any]:
        """{'companion': name, 'device': {...}, 'disclosureAccepted': bool, 'disclosure': text}."""
        _, d = await self._request("GET", "/device/whoami")
        if isinstance(d, dict) and d.get("device") is None and self.token:
            raise SaraAuthError("This device is no longer signed in to Sara.")
        return d

    async def accept_disclosure(self) -> None:
        await self._request("POST", "/disclosure/accept", {})

    async def logout(self) -> None:
        await self._request("POST", "/device/logout", {})

    async def companions(self) -> list[dict[str, Any]]:
        """Her companions on this server ([] when the server has only one)."""
        status, d = await self._request("GET", "/companions", ok_statuses=(404,))
        if status == 404 or not isinstance(d, dict):
            return []
        return [c for c in d.get("companions", []) if isinstance(c, dict)]

    # ---------- conversations ----------
    async def create_conversation(self, title: str = CONVERSATION_TITLE) -> str:
        _, conv = await self._request("POST", "/conversations", {})
        cid = str(conv["id"])
        await self._request("PATCH", f"/conversations/{cid}", {"title": title})
        return cid

    async def find_conversation(self, title: str = CONVERSATION_TITLE) -> str | None:
        """The newest saved conversation with this title."""
        _, convs = await self._request("GET", "/conversations")
        if not isinstance(convs, list):
            return None
        mine = [c for c in convs if isinstance(c, dict) and c.get("title") == title and not c.get("offRecord") and not c.get("archived")]
        mine.sort(key=lambda c: str(c.get("updatedAt") or c.get("createdAt") or ""), reverse=True)
        return str(mine[0]["id"]) if mine else None

    async def conversation_exists(self, cid: str) -> bool:
        status, _ = await self._request("GET", f"/conversations/{cid}/messages?limit=20", ok_statuses=(404,))
        return status != 404

    async def shared_conversation(self, title: str = CONVERSATION_TITLE) -> str:
        """The one 'Home Assistant' conversation (made the first time)."""
        return await self.find_conversation(title) or await self.create_conversation(title)

    async def send_note(self, cid: str, text: str) -> None:
        """Sends a message she answers in the background (her reply arrives like her other messages)."""
        await self._request("POST", f"/conversations/{cid}/messages", {"content": text, "background": True})

    async def send_message(self, cid: str, text: str) -> SaraReply:
        """One turn: sends the text and reads her reply from the stream until she's done.

        Approvals she asks for (running a command, changing a device) are declined: there's
        nobody to ask here. The reply says so, and they can be asked again in the Sara app.
        """
        reply = SaraReply(text="", conversation_id=cid)
        try:
            async with self._session.post(
                f"{self.url}/api/conversations/{cid}/messages",
                headers={**self._headers(True), "accept": "text/event-stream"},
                data=json.dumps({"content": text}),
                allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=self._timeout, sock_read=self._timeout),
            ) as res:
                if res.status >= 400:
                    try:
                        data = await res.json(content_type=None)
                    except ValueError:
                        data = {}
                    self._raise_for(res.status, data)
                async for ev in sse_events(res.content):
                    t = ev.get("type")
                    if t == "token":
                        reply.text += str(ev.get("text", ""))
                    elif t == "replace":
                        reply.text = str(ev.get("text", ""))
                        reply.replaced = True
                    elif t == "notice" and ev.get("kind") in ("disclosure", "crisis"):
                        reply.notices.append(str(ev.get("text", "")))
                    elif t == "approval":
                        reply.declined.append(str(ev.get("summary") or ev.get("name") or "do something"))
                        await self._request("POST", f"/approvals/{ev.get('approvalId')}", {"approved": False}, ok_statuses=(404, 409))
                    elif t == "error":
                        reply.error = str(ev.get("message", "error"))
                    elif t == "done":
                        pass
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise SaraConnectionError(f"Couldn't reach Sara at {self.url}: {err}") from err
        if reply.error and not reply.text.strip():
            # The AI notice (or crisis help) she showed first stays with the error.
            raise SaraError("\n\n".join([*(n for n in reply.notices if n), reply.error]))
        return reply
