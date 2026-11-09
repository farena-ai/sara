"""A fake Sara server (aiohttp) that speaks the parts of Sara's API the integration uses."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

from aiohttp import web

TOKEN = "sara_dev.abc123.fake-secret-for-tests"


@dataclass
class FakeSara:
    approved: bool = False
    denied: bool = False
    disclosure_accepted: bool = True
    token: str = TOKEN
    valid_tokens: set[str] = field(default_factory=lambda: {TOKEN})
    conversations: dict[str, dict[str, Any]] = field(default_factory=dict)
    received: list[tuple[str, str, bool]] = field(default_factory=list)
    reply: str = "Hi! I'm Sara."
    ask_approval: bool = False
    decisions: list[tuple[str, bool]] = field(default_factory=list)
    replace_with: str | None = None
    notice: str | None = None
    logged_out: bool = False
    companions: list[dict[str, Any]] | None = None
    started: int = 0
    # What the device-code request asked for, and the access the token has ('home-assistant' or 'full').
    asked_scope: str | None = None
    scope: str = "home-assistant"
    fail_with: str | None = None

    def authed(self, req: web.Request) -> bool:
        h = req.headers.get("authorization", "")
        return h.startswith("Bearer ") and h[7:] in self.valid_tokens

    def app(self) -> web.Application:
        app = web.Application()
        r = app.router
        r.add_get("/api/health", self.health)
        r.add_post("/api/device/start", self.start)
        r.add_post("/api/device/poll", self.poll)
        r.add_get("/api/device/whoami", self.guard(self.whoami))
        r.add_post("/api/device/logout", self.guard(self.logout))
        r.add_post("/api/disclosure/accept", self.guard(self.accept))
        r.add_get("/api/companions", self.guard(self.list_companions))
        r.add_get("/api/conversations", self.guard(self.list_convs))
        r.add_post("/api/conversations", self.guard(self.create_conv))
        r.add_patch("/api/conversations/{id}", self.guard(self.patch_conv))
        r.add_get("/api/conversations/{id}/messages", self.guard(self.get_messages))
        r.add_post("/api/conversations/{id}/messages", self.guard(self.message))
        r.add_post("/api/approvals/{id}", self.guard(self.approval))
        return app

    def guard(self, handler):
        async def wrapped(req: web.Request) -> web.StreamResponse:
            if not self.authed(req):
                return web.json_response({"error": "Not signed in"}, status=401)
            return await handler(req)

        return wrapped

    async def health(self, req: web.Request) -> web.Response:
        return web.json_response({"ok": True})

    async def start(self, req: web.Request) -> web.Response:
        if not req.content_type.startswith("application/json"):
            return web.json_response({"error": "Expected application/json"}, status=415)
        body = await req.json()
        assert body["name"]
        self.asked_scope = body.get("scope")
        self.started += 1
        host = req.headers["host"]
        return web.json_response({"code": "K7QM-3XTP", "pollToken": "poll-1", "expiresAt": "2099-01-01T00:00:00Z", "interval": 0.01, "verifyUrl": f"http://{host}/device", "approveIn": "Settings → Connections → Devices and sign-in"})

    async def poll(self, req: web.Request) -> web.Response:
        body = await req.json()
        if body.get("pollToken") != "poll-1":
            return web.json_response({"status": "expired"}, status=410)
        if self.denied:
            return web.json_response({"status": "denied"})
        if self.approved:
            return web.json_response({"status": "approved", "token": self.token, "deviceId": "abc123"})
        return web.json_response({"status": "pending"})

    async def whoami(self, req: web.Request) -> web.Response:
        return web.json_response({"companion": "Sara", "device": {"id": "abc123", "label": "Home Assistant", "scope": self.scope}, "disclosureAccepted": self.disclosure_accepted, "disclosure": "Sara is an AI, not a person."})

    async def logout(self, req: web.Request) -> web.Response:
        self.logged_out = True
        self.valid_tokens.discard(req.headers["authorization"][7:])
        return web.json_response({"ok": True})

    async def accept(self, req: web.Request) -> web.Response:
        self.disclosure_accepted = True
        return web.json_response({"ok": True})

    async def list_companions(self, req: web.Request) -> web.Response:
        if self.companions is None:
            return web.json_response({"error": "Not found"}, status=404)
        return web.json_response({"companions": self.companions, "planner": "shared"})

    async def list_convs(self, req: web.Request) -> web.Response:
        return web.json_response(list(self.conversations.values()))

    async def create_conv(self, req: web.Request) -> web.Response:
        cid = str(uuid.uuid4())
        self.conversations[cid] = {"id": cid, "title": "New conversation", "updatedAt": f"2026-10-27T00:00:{len(self.conversations):02d}Z"}
        return web.json_response(self.conversations[cid], status=201)

    async def patch_conv(self, req: web.Request) -> web.Response:
        cid = req.match_info["id"]
        if cid not in self.conversations:
            return web.json_response({"error": "Conversation not found"}, status=404)
        self.conversations[cid].update(await req.json())
        return web.json_response(self.conversations[cid])

    async def get_messages(self, req: web.Request) -> web.Response:
        if req.match_info["id"] not in self.conversations:
            return web.json_response({"error": "Conversation not found"}, status=404)
        return web.json_response({"messages": [], "earlier": 0})

    async def approval(self, req: web.Request) -> web.Response:
        self.decisions.append((req.match_info["id"], (await req.json()).get("approved") is True))
        return web.json_response({"ok": True})

    async def message(self, req: web.Request) -> web.StreamResponse:
        cid = req.match_info["id"]
        if cid not in self.conversations:
            return web.json_response({"error": "Conversation not found"}, status=404)
        if not self.disclosure_accepted:
            return web.json_response({"error": "Accept the disclosure first."}, status=403)
        body = await req.json()
        self.received.append((cid, body["content"], bool(body.get("background"))))
        if body.get("background"):
            return web.json_response({"ok": True}, status=202)
        res = web.StreamResponse(headers={"content-type": "text/event-stream; charset=utf-8"})
        await res.prepare(req)

        async def ev(e: dict[str, Any]) -> None:
            await res.write(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode())

        await res.write(b": ping\n\n")
        if self.notice:
            await ev({"type": "notice", "kind": "disclosure", "text": self.notice})
        await ev({"type": "notice", "kind": "fallback", "text": "switched model"})
        if self.fail_with:
            await ev({"type": "error", "message": self.fail_with})
            await res.write_eof()
            return res
        if self.ask_approval:
            await ev({"type": "approval", "approvalId": "ap-1", "id": "t1", "name": "home_control", "summary": "turn on light.kitchen", "args": {}})
            await ev({"type": "tool_result", "id": "t1", "name": "home_control", "status": "denied", "output": "declined", "ms": 1})
        words = self.reply.split(" ")
        for i, w in enumerate(words):
            await ev({"type": "token", "text": w + (" " if i < len(words) - 1 else "")})
        if self.replace_with is not None:
            await ev({"type": "replace", "messageId": 2, "text": self.replace_with})
        await ev({"type": "done", "messageId": 2})
        await res.write_eof()
        return res
