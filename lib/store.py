"""State persistence layer — Redis (Upstash REST) with local-file fallback.

Redis path:  one HSET/GET per request, SET NX distributed lock.
Local path:  JSON file + asyncio.Lock for single-process safety.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Optional

import httpx

from .models import AppState

# ---------------------------------------------------------------------------
# Configuration (from env vars, matching the JS originals)
# ---------------------------------------------------------------------------

STORE_KEY = "joseph:poker-platform:v2"
REDIS_URL = (os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL") or "").rstrip("/")
REDIS_TOKEN = os.environ.get("KV_REST_API_TOKEN") or os.environ.get("UPSTASH_REDIS_REST_TOKEN") or ""
LOCK_KEY = f"{STORE_KEY}:lock"
PRESENCE_KEY_PREFIX = f"{STORE_KEY}:presence"
LOCAL_STATE_FILE = os.environ.get("POKER_LOCAL_STATE_FILE") or str(Path("/tmp/joseph-poker-platform-v2.json"))

ROOM_TTL_MS: float = max(60_000, float(os.environ.get("POKER_ROOM_TTL_MS") or 3_600_000))
PLAYER_STALE_MS: float = max(60_000, float(os.environ.get("POKER_PLAYER_STALE_MS") or 5_400_000))
LEGACY_GHOST_MS: float = max(60_000, float(os.environ.get("POKER_LEGACY_GHOST_MS") or 120_000))
TURN_TIMEOUT_MS: float = max(15_000, float(os.environ.get("POKER_TURN_TIMEOUT_MS") or 30_000))

# ---------------------------------------------------------------------------
# Process-local state (survives multiple requests in a warm serverless instance)
# ---------------------------------------------------------------------------

_local_lock = asyncio.Lock()
_local_cache: Optional[dict] = None


def has_redis() -> bool:
    return bool(REDIS_URL and REDIS_TOKEN)


def presence_key(room_id: str, identity: str) -> str:
    return f"{PRESENCE_KEY_PREFIX}:{room_id.upper()}:{str(identity or '')[:160]}"


# ---------------------------------------------------------------------------
# Redis REST adapter (Upstash REST API — one HTTP call per command)
# ---------------------------------------------------------------------------

async def redis_command(command: str, *args: Any) -> Any:
    if not has_redis():
        return None
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.post(
            REDIS_URL,
            headers={
                "Authorization": f"Bearer {REDIS_TOKEN}",
                "Content-Type": "application/json",
            },
            json=[command, *args],
        )
        r.raise_for_status()
        return r.json().get("result")


# ---------------------------------------------------------------------------
# Distributed / local lock
# ---------------------------------------------------------------------------

async def with_store_lock(work):
    """Serialise mutations: Redis SET NX in production, asyncio.Lock locally."""
    if has_redis():
        lock_id = secrets.token_hex(16)
        deadline = time.time() + 6.0
        while time.time() < deadline:
            result = await redis_command("SET", LOCK_KEY, lock_id, "NX", "PX", "5000")
            if result == "OK":
                try:
                    return await work()
                finally:
                    try:
                        current = await redis_command("GET", LOCK_KEY)
                        if current == lock_id:
                            await redis_command("DEL", LOCK_KEY)
                    except Exception:
                        pass
            await asyncio.sleep(0.035 + secrets.randbelow(45) / 1000)
        raise RuntimeError("Poker table is busy. Try again in a second.")
    else:
        async with _local_lock:
            return await work()


# ---------------------------------------------------------------------------
# Load / save
# ---------------------------------------------------------------------------

async def load_state() -> AppState:
    global _local_cache
    from .engine import initial_state, normalize_state

    if has_redis():
        raw = await redis_command("GET", STORE_KEY)
        if raw:
            try:
                data = raw if isinstance(raw, dict) else json.loads(raw)
                return normalize_state(AppState.model_validate(data))
            except Exception:
                pass
    else:
        if _local_cache is not None:
            try:
                return normalize_state(AppState.model_validate(_local_cache))
            except Exception:
                pass
        try:
            path = Path(LOCAL_STATE_FILE)
            if path.exists():
                data = json.loads(path.read_text())
                _local_cache = data
                return normalize_state(AppState.model_validate(data))
        except Exception:
            pass

    state = initial_state()
    await save_state(state)
    return state


async def save_state(state: AppState) -> None:
    global _local_cache
    state.updated_at = time.time() * 1000
    data = state.model_dump(mode="json")
    if has_redis():
        await redis_command("SET", STORE_KEY, json.dumps(data))
    else:
        _local_cache = data
        try:
            path = Path(LOCAL_STATE_FILE)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data))
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Composite helpers used by routes
# ---------------------------------------------------------------------------

async def load_state_with_cleanup() -> AppState:
    """Load state and remove stale players / expired turns (read-heavy, not locked)."""
    from .engine import enforce_turn_timeout
    from .engine import cleanup_stale_players_in_room

    state = await load_state()
    changed = 0
    for room in list(state.rooms.values()):
        changed += await cleanup_stale_players_in_room(
            room, has_redis, redis_command, PLAYER_STALE_MS, LEGACY_GHOST_MS
        )
    changed += enforce_turn_timeout(state, TURN_TIMEOUT_MS)
    if not changed:
        return state
    # Re-run inside lock so cleanups are saved exactly once
    return await with_store_lock(_cleanup_and_save)


async def _cleanup_and_save() -> AppState:
    from .engine import enforce_turn_timeout, cleanup_stale_players_in_room

    state = await load_state()
    for room in list(state.rooms.values()):
        await cleanup_stale_players_in_room(
            room, has_redis, redis_command, PLAYER_STALE_MS, LEGACY_GHOST_MS
        )
    enforce_turn_timeout(state, TURN_TIMEOUT_MS)
    await save_state(state)
    return state


async def with_state(mutator) -> Any:
    """Load → mutate → save, inside the distributed lock."""
    return await with_store_lock(_make_locked_mutator(mutator))


def _make_locked_mutator(mutator):
    async def _inner():
        from .engine import enforce_turn_timeout, cleanup_stale_players_in_room

        state = await load_state()
        for room in list(state.rooms.values()):
            await cleanup_stale_players_in_room(
                room, has_redis, redis_command, PLAYER_STALE_MS, LEGACY_GHOST_MS
            )
        enforce_turn_timeout(state, TURN_TIMEOUT_MS)
        result = await mutator(state)
        await save_state(state)
        return result
    return _inner


async def prune_expired_rooms(state: AppState) -> int:
    from .engine import room_last_activity

    now = time.time() * 1000
    pruned = 0
    for room_id in list(state.rooms.keys()):
        room = state.rooms[room_id]
        if room.is_default or room_id == state.default_room_id:
            continue
        if now - room_last_activity(room) >= ROOM_TTL_MS:
            del state.rooms[room_id]
            pruned += 1
    return pruned
