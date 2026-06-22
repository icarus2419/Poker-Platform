"""FastAPI application — all poker API routes.

Route dispatch: vercel.json rewrites /api/<path> → /api/poker?route=<path>.
The single catch-all handler reads `route` from the query string and calls
the matching typed handler below. Each handler uses Pydantic request models
and returns plain dicts (FastAPI serialises them as JSON).
"""
from __future__ import annotations

import random
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

from .engine import (
    apply_action,
    cancel_hand_for_seat_change,
    configure_variant,
    create_room,
    first_open_seat,
    get_room,
    legal_actions_for_seat,
    make_player,
    mark_player_seen,
    mutation_payload,
    next_hand,
    normalize_state,
    reset_table,
    rooms_payload,
    seat_for_client_id,
    seat_for_token,
    serialize,
    start_hand,
    touch_room,
    _append_log,
    _ai_name,
    _sync_turn_timer,
)
from .models import (
    ActionBody,
    AddAiBody,
    AutoJoinBody,
    CloseRoomBody,
    CreateRoomBody,
    HeartbeatBody,
    JoinBody,
    KickBody,
    SimpleRoomBody,
)
from .store import (
    LEGACY_GHOST_MS,
    PLAYER_STALE_MS,
    ROOM_TTL_MS,
    TURN_TIMEOUT_MS,
    has_redis,
    load_state,
    load_state_with_cleanup,
    prune_expired_rooms,
    redis_command,
    with_state,
    presence_key,
)

app = FastAPI(title="Poker Platform API")

# Allow requests from the website, the Electron desktop app (file:// origin
# shows as null), and local dev servers.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ok(data: dict) -> JSONResponse:
    return JSONResponse(content=data, headers={"Cache-Control": "no-store"})


def _err(status: int, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": detail},
                        headers={"Cache-Control": "no-store"})


async def _parse_body(request: Request) -> dict:
    try:
        return await request.json()
    except Exception:
        return {}


def _find_room_by_client(state, client_id: str):
    cid = str(client_id or "").strip()
    if not cid:
        return None
    for room in state.rooms.values():
        if room.is_default:
            continue
        if room.creator_client_id and room.creator_client_id == cid:
            return room
    return None


def _rand_id(length: int = 6) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(alphabet) for _ in range(length))


# ---------------------------------------------------------------------------
# Main dispatch handler (receives ?route=... from Vercel rewrite)
# ---------------------------------------------------------------------------

@app.api_route("/{path:path}", methods=["GET", "POST", "OPTIONS"])
async def dispatch(request: Request, path: str = "") -> Any:
    if request.method == "OPTIONS":
        return JSONResponse(content={}, headers={"Cache-Control": "no-store"})

    # Prefer the rewrite query param; fall back to URL path segment
    route = (request.query_params.get("route") or path).strip("/").replace(".json", "")
    method = request.method

    try:
        # ── GET routes ──────────────────────────────────────────────────────
        if route == "health" and method == "GET":
            return await handle_health()

        if route == "rooms" and method == "GET":
            return await handle_list_rooms()

        if route == "state" and method == "GET":
            token = request.query_params.get("token", "")
            client_id = request.query_params.get("client_id", "")
            room_id = request.query_params.get("room_id", "")
            return await handle_state(room_id, token, client_id)

        if route == "variance/demo" and method == "GET":
            return await handle_variance_demo(request)

        # ── POST routes ─────────────────────────────────────────────────────
        if method != "POST":
            return PlainTextResponse("Not found", status_code=404)

        body_raw = await _parse_body(request)

        if route == "rooms/create":
            return await handle_create_room(CreateRoomBody.model_validate(body_raw))

        if route == "rooms/close":
            return await handle_close_room(CloseRoomBody.model_validate(body_raw))

        if route == "join":
            return await handle_join(JoinBody.model_validate(body_raw))

        if route == "auto_join":
            return await handle_auto_join(AutoJoinBody.model_validate(body_raw))

        if route == "heartbeat":
            return await handle_heartbeat(HeartbeatBody.model_validate(body_raw))

        if route == "add_ai":
            return await handle_add_ai(AddAiBody.model_validate(body_raw))

        if route == "kick":
            return await handle_kick(KickBody.model_validate(body_raw))

        if route == "leave":
            return await handle_leave(SimpleRoomBody.model_validate(body_raw))

        if route == "start_hand":
            return await handle_start_hand(SimpleRoomBody.model_validate(body_raw))

        if route == "next_hand":
            return await handle_next_hand(SimpleRoomBody.model_validate(body_raw))

        if route == "action":
            return await handle_action(ActionBody.model_validate(body_raw))

        if route == "reset":
            return await handle_reset(SimpleRoomBody.model_validate(body_raw))

        if route == "set_variant":
            return await handle_set_variant(body_raw)

        return PlainTextResponse("Not found", status_code=404)

    except (ValueError, RuntimeError) as exc:
        return _err(400, str(exc))
    except Exception as exc:
        return _err(400, str(exc))


# ---------------------------------------------------------------------------
# Individual route handlers (typed, FastAPI-style)
# ---------------------------------------------------------------------------

async def handle_health() -> JSONResponse:
    state = await load_state()
    return _ok({
        "ok": True,
        "service": "multiplayer-poker-platform",
        "default_room_id": state.default_room_id,
        "room_count": len(state.rooms),
        "private_room_count": len(rooms_payload(state)),
        "room_ttl_hours": ROOM_TTL_MS / 3_600_000,
        "player_stale_seconds": round(PLAYER_STALE_MS / 1000),
        "legacy_ghost_seconds": round(LEGACY_GHOST_MS / 1000),
        "turn_timeout_seconds": round(TURN_TIMEOUT_MS / 1000),
        "storage": "redis" if has_redis() else "temporary-file",
        "warning": (
            ""
            if has_redis()
            else "Temporary server storage is not reliable on Vercel. Add Redis env vars for real multiplayer."
        ),
    })


async def handle_list_rooms() -> JSONResponse:
    state = await load_state_with_cleanup()
    await prune_expired_rooms(state)
    return _ok({"rooms": rooms_payload(state), "default_room_id": state.default_room_id})


async def handle_state(room_id: str, token: str, client_id: str) -> JSONResponse:
    state = await load_state_with_cleanup()
    room = get_room(state, room_id)
    return _ok(serialize(room, token, client_id, TURN_TIMEOUT_MS))


async def handle_create_room(body: CreateRoomBody) -> JSONResponse:
    async def _mutate(state):
        client_id = str(body.client_id or "").strip()
        existing = _find_room_by_client(state, client_id)
        already_exists = False
        if existing:
            room = existing
            already_exists = True
            touch_room(room)
        else:
            rid = _rand_id()
            while rid in state.rooms:
                rid = _rand_id()
            room = create_room(body.name or "Poker Table", body.variant or "holdem",
                               body.max_seats or 6, rid, False, client_id)
            state.rooms[room.room_id] = room

        seat_index = None
        player_token = ""
        if body.auto_join and client_id:
            seat_index = seat_for_client_id(room.table, client_id)
            if seat_index is None:
                seat_index = first_open_seat(room.table)
            if seat_index is None:
                raise ValueError("Table is full")
            player = room.table.seats[seat_index]
            if player is None:
                player = make_player(seat_index,
                                     body.player_name or body.name or f"Player {seat_index + 1}",
                                     "human", client_id, room.table)
                room.table.seats[seat_index] = player
                cancel_hand_for_seat_change(room.table, "New player joined")
                _append_log(room.table, "System", f"{player.player_name} joined seat {seat_index + 1}")
            mark_player_seen(room, player.token or "", client_id)
            player_token = player.token or ""

        return {
            **mutation_payload(state, room, player_token, client_id, TURN_TIMEOUT_MS),
            "room_id": room.room_id,
            "creator_token": room.creator_token,
            "already_exists": already_exists,
            "seat_index": seat_index,
            "token": player_token,
            "warning": (
                ""
                if has_redis()
                else "Temporary server storage is active; add Redis env vars or this room may disappear on Vercel."
            ),
        }

    return _ok(await with_state(_mutate))


async def handle_close_room(body: CloseRoomBody) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body.room_id)
        if room.is_default:
            raise ValueError("The default table cannot be deleted")
        if room.creator_token != body.creator_token:
            raise ValueError("Creator token does not match")
        del state.rooms[room.room_id]
        return {"ok": True, "rooms": rooms_payload(state), "default_room_id": state.default_room_id}

    return _ok(await with_state(_mutate))


async def handle_join(body: JoinBody) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body.room_id)
        touch_room(room)
        t = room.table
        client_id = str(body.client_id or "").strip()

        if body.ai_level == "human" and client_id:
            existing_seat = seat_for_client_id(t, client_id)
            if existing_seat is not None:
                existing = t.seats[existing_seat]
                mark_player_seen(room, existing.token or "", client_id)
                return {
                    **mutation_payload(state, room, existing.token or "", client_id, TURN_TIMEOUT_MS),
                    "seat_index": existing_seat,
                    "token": existing.token or "",
                    "room_id": room.room_id,
                    "already_seated": True,
                }

        seat = body.seat_index if body.seat_index is not None else first_open_seat(t)
        if seat is None or seat < 0 or seat >= t.max_seats:
            raise ValueError("Invalid seat index")
        if t.seats[seat]:
            raise ValueError("Seat already occupied")
        p = make_player(seat, body.name or f"Player {seat + 1}",
                        body.ai_level or "human", client_id or None, t)
        t.seats[seat] = p
        cancel_hand_for_seat_change(t, "New player joined")
        _append_log(t, "System", f"{p.player_name} joined seat {seat + 1}")
        mark_player_seen(room, p.token or "", client_id)
        return {
            **mutation_payload(state, room, p.token or "", client_id, TURN_TIMEOUT_MS),
            "seat_index": seat,
            "token": p.token or "",
            "room_id": room.room_id,
        }

    return _ok(await with_state(_mutate))


async def handle_auto_join(body: AutoJoinBody) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body.room_id)
        touch_room(room)
        t = room.table
        client_id = str(body.client_id or "").strip()
        if not client_id:
            raise ValueError("Missing browser client id")

        seat = seat_for_client_id(t, client_id)
        if seat is not None:
            existing = t.seats[seat]
            mark_player_seen(room, existing.token or "", client_id)
            return {
                **mutation_payload(state, room, existing.token or "", client_id, TURN_TIMEOUT_MS),
                "seat_index": seat,
                "token": existing.token or "",
                "room_id": room.room_id,
                "already_seated": True,
            }

        seat = first_open_seat(t)
        if seat is None:
            raise ValueError("Table is full")
        p = make_player(seat, body.name or f"Player {seat + 1}", "human", client_id, t)
        t.seats[seat] = p
        cancel_hand_for_seat_change(t, "New player joined")
        _append_log(t, "System", f"{p.player_name} joined seat {seat + 1}")
        mark_player_seen(room, p.token or "", client_id)
        return {
            **mutation_payload(state, room, p.token or "", client_id, TURN_TIMEOUT_MS),
            "seat_index": seat,
            "token": p.token or "",
            "room_id": room.room_id,
        }

    return _ok(await with_state(_mutate))


async def handle_heartbeat(body: HeartbeatBody) -> JSONResponse:
    room_id = str(body.room_id or "").upper()
    identity = str(body.client_id or body.token or "").strip()
    if not room_id or not identity:
        return _ok({"ok": False, "stale_ms": PLAYER_STALE_MS,
                    "detail": "Missing room or browser identity"})

    if has_redis():
        await redis_command("SET", presence_key(room_id, identity),
                            "1", "EX", str(round(PLAYER_STALE_MS / 1000)))
        return _ok({"ok": True, "room_id": room_id, "stale_ms": PLAYER_STALE_MS,
                    "now": __import__("time").time() * 1000, "lightweight": True})

    async def _mutate(state):
        room = get_room(state, room_id)
        seat = mark_player_seen(room, body.token or "", body.client_id or "")
        if seat is None:
            return {"ok": False, "stale_ms": PLAYER_STALE_MS,
                    "detail": "No active human seat for this browser/token"}
        return {"ok": True, "room_id": room.room_id, "seat_index": seat,
                "stale_ms": PLAYER_STALE_MS, "now": __import__("time").time() * 1000}

    return _ok(await with_state(_mutate))


async def handle_add_ai(body: AddAiBody) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body.room_id)
        touch_room(room)
        t = room.table
        seat = int(body.seat_index)
        if seat < 0 or seat >= t.max_seats:
            raise ValueError("Invalid seat index")
        if t.seats[seat]:
            raise ValueError("Seat already occupied")
        level = body.ai_level or "ai_easy"
        p = make_player(seat, body.name or _ai_name(level), level, None, t)
        t.seats[seat] = p
        cancel_hand_for_seat_change(t, "Bot added")
        _append_log(t, "System", f"{p.player_name} joined seat {seat + 1}")
        mark_player_seen(room, body.token or "", body.client_id or "")
        return {
            **mutation_payload(state, room, body.token or "", body.client_id or "", TURN_TIMEOUT_MS),
            "seat_index": seat,
            "token": None,
            "room_id": room.room_id,
        }

    return _ok(await with_state(_mutate))


async def handle_kick(body: KickBody) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body.room_id)
        touch_room(room)
        if room.is_default:
            raise ValueError("Cannot kick players from the default table")
        if not room.creator_token or room.creator_token != body.creator_token:
            raise ValueError("Only the room creator can kick players")
        seat = int(body.seat_index)
        if not (0 <= seat < room.table.max_seats):
            raise ValueError("Invalid seat index")
        player = room.table.seats[seat]
        if not player:
            raise ValueError("That seat is already empty")
        kicked_token = player.token or ""
        _append_log(room.table, "System", f"{player.player_name} was removed by the room creator")
        room.table.seats[seat] = None
        cancel_hand_for_seat_change(room.table, "Player removed")
        _sync_turn_timer(room.table, force=True)
        effective_token = "" if kicked_token == body.token else (body.token or "")
        return {
            **mutation_payload(state, room, effective_token, body.client_id or "", TURN_TIMEOUT_MS),
            "kicked_seat": seat,
            "kicked_token": kicked_token,
            "room_id": room.room_id,
        }

    return _ok(await with_state(_mutate))


async def handle_leave(body: SimpleRoomBody) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body.room_id)
        touch_room(room)
        seat = seat_for_token(room.table, body.token)
        if seat is None:
            raise ValueError("Unknown player token")
        p = room.table.seats[seat]
        _append_log(room.table, "System", f"{p.player_name} left the table")
        room.table.seats[seat] = None
        cancel_hand_for_seat_change(room.table, "Player left")
        touch_room(room)
        return mutation_payload(state, room, "", body.client_id or "", TURN_TIMEOUT_MS)

    return _ok(await with_state(_mutate))


async def handle_start_hand(body: SimpleRoomBody) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body.room_id)
        touch_room(room)
        mark_player_seen(room, body.token or "", body.client_id or "")
        start_hand(room.table)
        return mutation_payload(state, room, body.token or "", body.client_id or "", TURN_TIMEOUT_MS)

    return _ok(await with_state(_mutate))


async def handle_next_hand(body: SimpleRoomBody) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body.room_id)
        touch_room(room)
        mark_player_seen(room, body.token or "", body.client_id or "")
        next_hand(room.table)
        return mutation_payload(state, room, body.token or "", body.client_id or "", TURN_TIMEOUT_MS)

    return _ok(await with_state(_mutate))


async def handle_action(body: ActionBody) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body.room_id)
        touch_room(room)
        mark_player_seen(room, body.token or "", body.client_id or "")
        seat = seat_for_token(room.table, body.token)
        if seat is None:
            raise ValueError("Player token not linked")
        apply_action(room.table, seat, body.action,
                     float(body.amount) if body.amount is not None else None,
                     body.token)
        return mutation_payload(state, room, body.token or "", body.client_id or "", TURN_TIMEOUT_MS)

    return _ok(await with_state(_mutate))


async def handle_reset(body: SimpleRoomBody) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body.room_id)
        touch_room(room)
        mark_player_seen(room, body.token or "", body.client_id or "")
        reset_table(room.table)
        return mutation_payload(state, room, body.token or "", body.client_id or "", TURN_TIMEOUT_MS)

    return _ok(await with_state(_mutate))


async def handle_set_variant(body_raw: dict) -> JSONResponse:
    async def _mutate(state):
        room = get_room(state, body_raw.get("room_id", ""))
        touch_room(room)
        mark_player_seen(room, body_raw.get("token", ""), body_raw.get("client_id", ""))
        configure_variant(room.table, body_raw.get("variant", "holdem"))
        return mutation_payload(state, room,
                                body_raw.get("token", ""),
                                body_raw.get("client_id", ""),
                                TURN_TIMEOUT_MS)

    return _ok(await with_state(_mutate))


async def handle_variance_demo(request: Request) -> JSONResponse:
    params = request.query_params
    hands = max(10, min(int(params.get("hands") or 100), 500))
    agent_a = params.get("agent_a") or "ai_hard"
    agent_b = params.get("agent_b") or "ai_medium"
    edge_map = {"ai_easy": -2, "ai_medium": 0, "ai_hard": 2}
    edge = edge_map.get(agent_a, 0) - edge_map.get(agent_b, 0)
    stderr = max(0.2, 18 / (hands ** 0.5))
    import random as _r
    return _ok({
        "agent_a": agent_a,
        "agent_b": agent_b,
        "hands": hands,
        "variant": params.get("variant") or "holdem",
        "naive": {
            "mean_edge": edge + (_r.random() - 0.5) * stderr * 2,
            "stderr": stderr,
        },
        "reduced": {
            "mean_edge": edge + (_r.random() - 0.5) * stderr,
            "stderr": stderr / 2.4,
        },
        "variance_reduction_factor": 2.4,
    })
