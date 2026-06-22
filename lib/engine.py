"""Pure game-engine logic — no I/O, no HTTP, no Redis.

Boundaries:
  - Takes and returns domain models from .models
  - All randomness is explicit (deck shuffle, seed)
  - AI decisions live here, isolated from transport
"""
from __future__ import annotations

import random
import secrets
import time
from itertools import combinations
from typing import Any, Optional

from .models import AppState, Player, Room, Table, Variant


# ---------------------------------------------------------------------------
# Time helper
# ---------------------------------------------------------------------------

def now_ms() -> float:
    return time.time() * 1000


# ---------------------------------------------------------------------------
# Variant definitions
# ---------------------------------------------------------------------------

def variant_for(name: str) -> Variant:
    if str(name or "").lower() == "highcard":
        return Variant(
            variant_name="highcard", display_name="High-card only (toy)",
            min_players=2, default_starting_stack=100,
            hole_cards=1, cards_per_round=[0],
            uses_blinds=False, small_blind=0, big_blind=0, ante=1, min_open_bet=1,
        )
    return Variant(
        variant_name="holdem", display_name="No-limit Hold'em",
        min_players=2, default_starting_stack=1000,
        hole_cards=2, cards_per_round=[0, 3, 1, 1],
        uses_blinds=True, small_blind=5, big_blind=10, ante=0, min_open_bet=10,
    )


# ---------------------------------------------------------------------------
# Room / table construction
# ---------------------------------------------------------------------------

def _rand_id(length: int = 6) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(alphabet) for _ in range(length))


def fresh_table(variant_name: str = "holdem", max_seats: int = 6) -> Table:
    v = variant_for(variant_name)
    n = max(2, min(9, int(max_seats)))
    return Table(
        variant=v,
        max_seats=n,
        seats=[None] * n,
        min_raise_increment=v.min_open_bet,
        status_message="Waiting for players",
        log=[{"actor": "System", "message": f"Table created for {v.display_name}"}],
    )


def create_room(
    name: str,
    variant: str = "holdem",
    max_seats: int = 6,
    room_id: Optional[str] = None,
    is_default: bool = False,
    creator_client_id: str = "",
) -> Room:
    code = str(room_id or _rand_id()).strip().upper()
    table = fresh_table(variant, max_seats)
    ts = now_ms()
    return Room(
        room_id=code,
        name=str(name or "Poker Table").strip()[:48] or "Poker Table",
        table=table,
        created_at=ts,
        last_activity_at=ts,
        is_default=is_default,
        creator_token="" if is_default else secrets.token_hex(16),
        creator_client_id="" if is_default else str(creator_client_id or "")[:120],
    )


def initial_state() -> AppState:
    main = create_room("Main Table", "holdem", 6, "MAIN01", is_default=True)
    return AppState(rooms={"MAIN01": main})


# ---------------------------------------------------------------------------
# Normalization (called after loading persisted state)
# ---------------------------------------------------------------------------

def normalize_room(room: Room) -> None:
    t = room.table
    t.variant = variant_for(t.variant.variant_name)
    n = max(2, min(9, t.max_seats))
    t.max_seats = n
    while len(t.seats) < n:
        t.seats.append(None)
    t.seats = t.seats[:n]
    for i, p in enumerate(t.seats):
        if p is None:
            continue
        if not hasattr(p, "seat_number") or p.seat_number != i:
            p.seat_number = i
        if p.ai_level == "human" and p.last_seen_at is None:
            p.last_seen_at = room.last_activity_at or room.created_at or now_ms()
    t.log = (t.log or [])[:200]
    t.last_showdown = t.last_showdown or []
    t.community_cards = t.community_cards or []
    t.players_to_act = t.players_to_act or []
    if t.turn_actor_index is not None and not isinstance(t.turn_actor_index, int):
        t.turn_actor_index = None


def normalize_state(state: AppState) -> AppState:
    if "MAIN01" not in state.rooms:
        state.rooms["MAIN01"] = create_room("Main Table", "holdem", 6, "MAIN01", is_default=True)
    state.default_room_id = state.default_room_id or "MAIN01"
    for room in state.rooms.values():
        normalize_room(room)
    return state


# ---------------------------------------------------------------------------
# Room helpers
# ---------------------------------------------------------------------------

def touch_room(room: Room) -> None:
    if not room.is_default:
        room.last_activity_at = now_ms()


def room_last_activity(room: Room) -> float:
    latest = float(room.last_activity_at or room.created_at or 0)
    for p in room.table.seats:
        if p and p.ai_level == "human":
            seen = float(p.last_seen_at or 0)
            if seen > latest:
                latest = seen
    return latest


def get_room(state: AppState, room_id: Optional[str]) -> Room:
    rid = str(room_id or state.default_room_id or "MAIN01").upper()
    room = state.rooms.get(rid)
    if not room:
        raise ValueError("This room doesn't exist yet. Create or join another table.")
    normalize_room(room)
    return room


def rooms_payload(state: AppState) -> list[dict]:
    return [
        room_summary(r)
        for r in state.rooms.values()
        if r and not r.is_default and r.room_id.upper() != "MAIN01"
    ]


def room_summary(room: Room) -> dict:
    players = [p for p in room.table.seats if p]
    created = float(room.created_at or now_ms())
    activity = float(room.last_activity_at or created)
    from .store import ROOM_TTL_MS
    return {
        "room_id": room.room_id,
        "name": room.name,
        "variant": room.table.variant.variant_name,
        "variant_display": room.table.variant.display_name,
        "max_seats": room.table.max_seats,
        "occupied_seats": len(players),
        "open_seats": room.table.max_seats - len(players),
        "hand_in_progress": bool(room.table.hand_in_progress),
        "hand_complete": bool(room.table.hand_complete),
        "game_complete": bool(room.table.game_winner),
        "game_winner": room.table.game_winner,
        "status_message": room.table.status_message or "Waiting for players",
        "is_default": room.is_default,
        "created_at": created,
        "last_activity_at": activity,
        "expires_at": None if room.is_default else activity + ROOM_TTL_MS,
    }


# ---------------------------------------------------------------------------
# Player helpers
# ---------------------------------------------------------------------------

def make_player(seat_index: int, name: str, ai_level: str = "human",
                client_id: Optional[str] = None, table: Optional[Table] = None) -> Player:
    stack = table.variant.default_starting_stack if table else 1000
    return Player(
        seat_number=seat_index,
        player_name=str(name or f"Player {seat_index + 1}").strip()[:32] or f"Player {seat_index + 1}",
        ai_level=ai_level or "human",
        token=secrets.token_hex(16) if ai_level == "human" else None,
        client_id=str(client_id or "")[:120] if (ai_level == "human" and client_id) else None,
        last_seen_at=now_ms() if ai_level == "human" else None,
        chip_stack=stack,
    )


def seat_for_token(t: Table, viewer_token: str) -> Optional[int]:
    if not viewer_token:
        return None
    for i, p in enumerate(t.seats):
        if p and p.token == viewer_token:
            return i
    return None


def seat_for_client_id(t: Table, client_id: str) -> Optional[int]:
    cid = str(client_id or "").strip()
    if not cid:
        return None
    for i, p in enumerate(t.seats):
        if p and p.ai_level == "human" and p.client_id == cid:
            return i
    return None


def first_open_seat(t: Table) -> Optional[int]:
    for i, p in enumerate(t.seats):
        if p is None:
            return i
    return None


def human_seat_for_presence(t: Table, player_token: str, client_id: str) -> Optional[int]:
    seat = seat_for_token(t, player_token)
    if seat is not None:
        return seat
    return seat_for_client_id(t, client_id)


def mark_player_seen(room: Room, player_token: str = "", client_id: str = "") -> Optional[int]:
    seat = human_seat_for_presence(room.table, player_token, client_id)
    if seat is None:
        return None
    p = room.table.seats[seat]
    if not p or p.ai_level != "human":
        return None
    p.last_seen_at = now_ms()
    if client_id and not p.client_id:
        p.client_id = str(client_id)[:120]
    touch_room(room)
    return seat


# ---------------------------------------------------------------------------
# Stale player / turn-timeout cleanup
# ---------------------------------------------------------------------------

def cancel_hand_for_seat_change(t: Table, reason: str = "Players changed") -> bool:
    if not t.hand_in_progress or t.hand_complete:
        return False
    for p in _iter_players(t):
        p.chip_stack += int(p.chips_in_pot or 0)
    _soft_reset(t)
    for p in _iter_players(t):
        _reset_player_for_hand(p)
    t.status_message = f"{reason} — start a fresh hand"
    _append_log(t, "System", t.status_message)
    return True


async def cleanup_stale_players_in_room(room: Room, has_redis_fn, redis_fn,
                                         player_stale_ms: float, legacy_ghost_ms: float) -> int:
    t = room.table
    changed = 0
    removed = 0
    ts = now_ms()
    for i, p in enumerate(t.seats):
        if p is None or p.ai_level != "human":
            continue
        last_seen = float(p.last_seen_at or room.last_activity_at or room.created_at or ts)
        name = str(p.player_name or "").strip().lower()
        is_named_ghost = name in ("mystery player", "mystery")
        is_legacy_ghost = not p.client_id and ts - last_seen >= legacy_ghost_ms
        is_timed_out = ts - last_seen >= player_stale_ms
        if not (is_named_ghost or is_legacy_ghost or is_timed_out):
            continue
        if has_redis_fn():
            identity = p.client_id or p.token
            if identity:
                alive = await redis_fn("GET", _presence_key_raw(room.room_id, identity))
                if alive:
                    p.last_seen_at = ts
                    changed += 1
                    continue
        label = "stale ghost seat" if (is_named_ghost or is_legacy_ghost) else "closed tab"
        _append_log(t, "System", f"{p.player_name} left after {label}")
        t.seats[i] = None
        removed += 1
        changed += 1
    if removed:
        cancel_hand_for_seat_change(t, "Player disconnected")
        touch_room(room)
    return changed


def _presence_key_raw(room_id: str, identity: str) -> str:
    from .store import PRESENCE_KEY_PREFIX
    return f"{PRESENCE_KEY_PREFIX}:{room_id.upper()}:{str(identity or '')[:160]}"


def enforce_turn_timeout(state: AppState, turn_timeout_ms: float) -> int:
    changed = 0
    for room in state.rooms.values():
        if _apply_turn_timeout(room.table, turn_timeout_ms):
            touch_room(room)
            changed += 1
    return changed


def _apply_turn_timeout(t: Table, turn_timeout_ms: float) -> bool:
    if not t.hand_in_progress or t.hand_complete:
        return False
    actor = _current_actor(t)
    if actor is None:
        _sync_turn_timer(t)
        return False
    _sync_turn_timer(t)
    elapsed = now_ms() - float(t.turn_started_at or 0)
    if elapsed < turn_timeout_ms:
        return False
    p = t.seats[actor]
    if not p or p.ai_level != "human":
        return False
    legal = [a["action"] for a in legal_actions_for_seat(t, actor)]
    action = "check" if "check" in legal else "fold"
    _append_log(t, "System", f"{p.player_name} timed out — auto-{action}")
    apply_action(t, actor, action, None, None)
    return True


# ---------------------------------------------------------------------------
# Card deck
# ---------------------------------------------------------------------------

_RANKS = list("23456789TJQKA")
_SUITS = list("cdhs")

def _make_deck() -> list[str]:
    return [r + s for r in _RANKS for s in _SUITS]


def _shuffle(cards: list[str]) -> list[str]:
    deck = list(cards)
    random.shuffle(deck)
    return deck


def _draw(t: Table, count: int) -> list[str]:
    cards = t.deck[:count]
    t.deck = t.deck[count:]
    return cards


# ---------------------------------------------------------------------------
# Table state helpers
# ---------------------------------------------------------------------------

def _iter_players(t: Table) -> list[Player]:
    return [p for p in t.seats if p is not None]


def _occupied_with_chips(t: Table) -> list[int]:
    return [i for i, p in enumerate(t.seats) if p and p.chip_stack > 0]


def _active_non_folded(t: Table) -> list[int]:
    return [
        i for i, p in enumerate(t.seats)
        if p and not p.folded and (p.chip_stack > 0 or p.chips_in_pot > 0)
    ]


def _total_pot(t: Table) -> int:
    return sum(p.chips_in_pot for p in _iter_players(t))


def _current_actor(t: Table) -> Optional[int]:
    return t.players_to_act[0] if t.players_to_act else None


def _append_log(t: Table, actor: str, message: str) -> None:
    t.log.insert(0, {"actor": actor, "message": message})
    t.log = t.log[:200]


def _soft_reset(t: Table) -> None:
    t.community_cards = []
    t.deck = []
    t.street_index = 0
    t.current_hand_seed = None
    t.current_bet_to_call = 0
    t.min_raise_increment = t.variant.min_open_bet
    t.players_to_act = []
    t.turn_actor_index = None
    t.turn_started_at = 0.0
    t.hand_in_progress = False
    t.hand_complete = False
    t.last_showdown = []


def _reset_player_for_hand(p: Player) -> None:
    p.hole_cards = []
    p.current_bet = 0
    p.chips_in_pot = 0
    p.folded = False
    p.all_in = False
    p.acted_this_round = False
    p.eliminated = p.chip_stack == 0
    p.last_action = ""


def _post_chips(p: Player, amount: int) -> int:
    pay = max(0, min(int(amount), p.chip_stack))
    p.chip_stack -= pay
    p.current_bet += pay
    p.chips_in_pot += pay
    if p.chip_stack == 0:
        p.all_in = True
    return pay


def _next_occupied_from(t: Table, index: int) -> int:
    for offset in range(1, t.max_seats + 1):
        candidate = ((index or 0) + offset) % t.max_seats
        p = t.seats[candidate]
        if p and p.chip_stack > 0:
            return candidate
    raise ValueError("No seat with chips available")


def _next_active(t: Table, index: int) -> Optional[int]:
    for offset in range(1, t.max_seats + 1):
        candidate = ((index or 0) + offset) % t.max_seats
        p = t.seats[candidate]
        if p and not p.folded and (p.chip_stack > 0 or p.chips_in_pot > 0):
            return candidate
    return None


def _action_queue_from(t: Table, starting_seat: Optional[int]) -> list[int]:
    if starting_seat is None:
        return []
    queue = []
    cur = starting_seat
    seen: set[int] = set()
    while cur is not None and cur not in seen:
        seen.add(cur)
        p = t.seats[cur]
        if p and not p.folded and not p.all_in:
            queue.append(cur)
        cur = _next_active(t, cur)
    return queue


def _players_needing_response(t: Table, start_after: int) -> list[int]:
    queue = []
    cur = _next_active(t, start_after)
    seen: set[int] = set()
    while cur is not None and cur not in seen:
        seen.add(cur)
        p = t.seats[cur]
        if p and not p.folded and not p.all_in and p.current_bet < t.current_bet_to_call:
            queue.append(cur)
        cur = _next_active(t, cur)
    return queue


def _everyone_settled(t: Table) -> bool:
    active = [t.seats[i] for i in _active_non_folded(t) if t.seats[i] and not t.seats[i].all_in]
    if not active:
        return True
    return all(p.current_bet == t.current_bet_to_call for p in active) and not t.players_to_act


def _street_name(t: Table) -> str:
    if t.variant.variant_name == "highcard":
        return "Single betting round"
    return (["Pre-flop", "Flop", "Turn", "River"] + [f"Betting round {t.street_index + 1}"])[
        min(t.street_index, 3)
    ]


def _sync_turn_timer(t: Table, force: bool = False) -> None:
    actor = _current_actor(t)
    if not t.hand_in_progress or t.hand_complete or actor is None:
        t.turn_actor_index = None
        t.turn_started_at = 0.0
        return
    if force or t.turn_actor_index != actor or not t.turn_started_at:
        t.turn_actor_index = actor
        t.turn_started_at = now_ms()


def _update_game_winner(t: Table) -> Optional[dict]:
    occupied = _iter_players(t)
    alive = [p for p in occupied if p.chip_stack > 0]
    if len(occupied) >= t.variant.min_players and len(alive) == 1:
        w = alive[0]
        winner: dict[str, Any] = {
            "seat_number": w.seat_number,
            "player_name": w.player_name,
            "ai_level": w.ai_level,
            "chip_stack": w.chip_stack,
            "hand_id": t.hand_id,
            "won_at": now_ms(),
        }
        already = (
            t.game_winner and
            int(t.game_winner.get("seat_number", -1)) == w.seat_number
        )
        t.game_winner = winner
        t.status_message = f"{w.player_name} wins the game"
        if not already:
            _append_log(t, "System", f"{w.player_name} wins the overall game")
        return t.game_winner
    t.game_winner = None
    return None


# ---------------------------------------------------------------------------
# Hand lifecycle
# ---------------------------------------------------------------------------

def start_hand(t: Table) -> None:
    if t.hand_in_progress and not t.hand_complete:
        raise ValueError("A hand is already in progress")
    if not t.game_winner:
        _update_game_winner(t)
    if t.game_winner:
        raise ValueError("The game is over. Restart the table to play again.")
    taken = _occupied_with_chips(t)
    if len(taken) < t.variant.min_players:
        raise ValueError(f"Need at least {t.variant.min_players} players with chips")

    t.hand_id += 1
    t.hand_in_progress = True
    t.hand_complete = False
    t.last_showdown = []
    t.community_cards = []
    t.street_index = 0
    t.current_hand_seed = random.randint(0, 10 ** 9)
    t.deck = _shuffle(_make_deck())

    for p in _iter_players(t):
        _reset_player_for_hand(p)

    t.button_index = _next_occupied_from(t, t.button_index)
    _append_log(t, "System", f"Starting hand #{t.hand_id}")
    _append_log(t, "System", f"Dealer button is on seat {t.button_index + 1}")

    for s in taken:
        t.seats[s].hole_cards = _draw(t, t.variant.hole_cards)

    if t.variant.ante:
        for s in taken:
            _post_chips(t.seats[s], t.variant.ante)

    if t.variant.uses_blinds:
        sb = t.button_index if len(taken) == 2 else _next_occupied_from(t, t.button_index)
        bb = _next_occupied_from(t, sb)
        _post_chips(t.seats[sb], t.variant.small_blind)
        _post_chips(t.seats[bb], t.variant.big_blind)
        t.seats[sb].last_action = f"small blind {t.variant.small_blind}"
        t.seats[bb].last_action = f"big blind {t.variant.big_blind}"
        t.current_bet_to_call = t.seats[bb].current_bet
        t.min_raise_increment = max(t.variant.big_blind, 1)
        _append_log(t, t.seats[sb].player_name, f"posts small blind {t.variant.small_blind}")
        _append_log(t, t.seats[bb].player_name, f"posts big blind {t.variant.big_blind}")
        t.players_to_act = _action_queue_from(t, _next_active(t, bb))
    else:
        t.current_bet_to_call = 0
        t.players_to_act = _action_queue_from(t, _next_active(t, t.button_index))

    t.status_message = _street_name(t)
    _advance_ai_until_human(t)
    _sync_turn_timer(t, force=True)


def next_hand(t: Table) -> None:
    if not t.hand_complete and t.hand_in_progress:
        raise ValueError("Finish the current hand first")
    if t.game_winner:
        raise ValueError("The game is over. Restart the table to play again.")
    start_hand(t)


def reset_table(t: Table) -> None:
    _soft_reset(t)
    t.game_winner = None
    for p in _iter_players(t):
        p.chip_stack = t.variant.default_starting_stack
        _reset_player_for_hand(p)
    t.status_message = "Table reset"
    _append_log(t, "System", "Table reset")


def configure_variant(t: Table, variant_name: str) -> None:
    t.variant = variant_for(variant_name)
    _soft_reset(t)
    t.game_winner = None
    for p in _iter_players(t):
        p.chip_stack = t.variant.default_starting_stack
        _reset_player_for_hand(p)
    t.status_message = f"Ready: {t.variant.display_name}"
    _append_log(t, "System", f"Variant changed to {t.variant.display_name}")


# ---------------------------------------------------------------------------
# Legal actions
# ---------------------------------------------------------------------------

def legal_actions_for_seat(t: Table, seat_index: int) -> list[dict]:
    p = t.seats[seat_index]
    if (not p or p.folded or p.all_in or
            _current_actor(t) != seat_index or
            not t.hand_in_progress or t.hand_complete):
        return []
    call_amount = max(0, t.current_bet_to_call - p.current_bet)
    actions: list[dict] = [{"action": "fold"}]
    if call_amount == 0:
        actions.append({"action": "check"})
        if p.chip_stack > 0:
            min_bet = p.current_bet + min(p.chip_stack, t.variant.min_open_bet)
            max_bet = p.current_bet + p.chip_stack
            actions.append({"action": "bet", "min_total": min_bet, "max_total": max_bet})
    else:
        actions.append({"action": "call", "call_amount": min(call_amount, p.chip_stack)})
        if p.chip_stack > call_amount:
            min_raise = t.current_bet_to_call + t.min_raise_increment
            max_raise = p.current_bet + p.chip_stack
            if max_raise >= min_raise:
                actions.append({"action": "raise", "min_total": min_raise, "max_total": max_raise})
    if p.chip_stack > 0:
        all_in_total = p.current_bet + p.chip_stack
        actions.append({"action": "all_in", "min_total": all_in_total, "max_total": all_in_total})
    return actions


# ---------------------------------------------------------------------------
# Action application
# ---------------------------------------------------------------------------

def apply_action(t: Table, actor_seat: int, action: str,
                 amount: Optional[float], player_token: Optional[str]) -> None:
    if not t.hand_in_progress or t.hand_complete:
        raise ValueError("No active hand")
    if _current_actor(t) != actor_seat:
        raise ValueError("It is not that seat's turn")
    p = t.seats[actor_seat]
    if not p:
        raise ValueError("No player in that seat")
    if player_token and p.token != player_token:
        raise ValueError("Token does not match that player")
    allowed = {a["action"]: a for a in legal_actions_for_seat(t, actor_seat)}
    if action not in allowed:
        raise ValueError("Illegal action")

    reopened = False
    if action == "fold":
        p.folded = True
        p.last_action = "fold"
        _append_log(t, p.player_name, "folds")
    elif action == "check":
        p.last_action = "check"
        _append_log(t, p.player_name, "checks")
    elif action == "call":
        amt = int(allowed["call"].get("call_amount", 0))
        _post_chips(p, amt)
        p.last_action = f"call {amt}"
        _append_log(t, p.player_name, f"calls {amt}")
    elif action in ("bet", "raise"):
        spec = allowed[action]
        target = int(spec["min_total"]) if amount is None else int(amount)
        if target < spec["min_total"] or target > spec["max_total"]:
            raise ValueError("Bet/raise amount out of range")
        prev_bet = t.current_bet_to_call
        _post_chips(p, target - p.current_bet)
        t.current_bet_to_call = p.current_bet
        inc = t.current_bet_to_call - prev_bet
        t.min_raise_increment = max(inc, t.variant.min_open_bet)
        p.last_action = f"{action} to {target}"
        _append_log(t, p.player_name, f"{action}s to {target}")
        reopened = True
    elif action == "all_in":
        prev_bet = t.current_bet_to_call
        _post_chips(p, p.chip_stack)
        if p.current_bet > t.current_bet_to_call:
            raise_size = p.current_bet - prev_bet
            t.current_bet_to_call = p.current_bet
            if raise_size >= t.min_raise_increment:
                t.min_raise_increment = max(raise_size, t.variant.min_open_bet)
                reopened = True
        p.last_action = f"all-in {p.current_bet}"
        _append_log(t, p.player_name, f"goes all-in to {p.current_bet}")

    p.acted_this_round = True
    t.players_to_act = [s for s in t.players_to_act if s != actor_seat]
    _resolve_after_action(t, actor_seat, reopened)
    _sync_turn_timer(t)


def _resolve_after_action(t: Table, actor_seat: int, reopened: bool) -> None:
    contenders = _active_non_folded(t)
    if len(contenders) == 1:
        _award_uncontested(t, contenders[0])
        return
    if reopened:
        t.players_to_act = _players_needing_response(t, actor_seat)
    if _everyone_settled(t) or not t.players_to_act:
        _advance_phase(t)
        return
    _advance_ai_until_human(t)


def _advance_phase(t: Table) -> None:
    if not t.hand_in_progress:
        return
    live_can_act = any(
        p and not p.all_in and p.chip_stack > 0
        for p in (t.seats[i] for i in _active_non_folded(t))
    )
    if not live_can_act:
        _run_out_and_showdown(t)
        return
    if t.street_index + 1 >= len(t.variant.cards_per_round):
        _resolve_showdown(t)
        return
    for p in _iter_players(t):
        p.current_bet = 0
        p.acted_this_round = False
    t.current_bet_to_call = 0
    t.min_raise_increment = t.variant.min_open_bet
    t.street_index += 1
    cards_to_deal = t.variant.cards_per_round[t.street_index]
    if cards_to_deal:
        t.community_cards.extend(_draw(t, cards_to_deal))
    t.status_message = _street_name(t)
    _append_log(t, "System", t.status_message)
    t.players_to_act = _action_queue_from(t, _next_active(t, t.button_index))
    if _everyone_settled(t):
        _run_out_and_showdown(t)
        return
    _advance_ai_until_human(t)
    _sync_turn_timer(t, force=True)


def _run_out_and_showdown(t: Table) -> None:
    while t.street_index + 1 < len(t.variant.cards_per_round):
        for p in _iter_players(t):
            p.current_bet = 0
        t.current_bet_to_call = 0
        t.street_index += 1
        cards_to_deal = t.variant.cards_per_round[t.street_index]
        if cards_to_deal:
            t.community_cards.extend(_draw(t, cards_to_deal))
            _append_log(t, "System", f"Runout: {_street_name(t)}")
    t.players_to_act = []
    _resolve_showdown(t)


def _award_uncontested(t: Table, winner_seat: int) -> None:
    pot = _total_pot(t)
    w = t.seats[winner_seat]
    w.chip_stack += pot
    _append_log(t, "System", f"{w.player_name} wins {pot} uncontested")
    t.last_showdown = [{"seat_number": winner_seat, "player_name": w.player_name,
                         "amount": pot, "reason": "uncontested"}]
    _finish_hand(t)


def _finish_hand(t: Table) -> None:
    t.hand_in_progress = False
    t.hand_complete = True
    t.players_to_act = []
    t.turn_actor_index = None
    t.turn_started_at = 0.0
    t.current_bet_to_call = 0
    for p in _iter_players(t):
        p.current_bet = 0
        p.chips_in_pot = 0
        p.all_in = False
    t.status_message = "Hand complete"
    _update_game_winner(t)


# ---------------------------------------------------------------------------
# Hand evaluation (poker hand ranking)
# ---------------------------------------------------------------------------

_RANK_VALUE = {r: i + 2 for i, r in enumerate("23456789TJQKA")}


def _evaluate5(cards: list[str]) -> tuple:
    values = sorted([_RANK_VALUE[c[0]] for c in cards], reverse=True)
    suits = [c[1] for c in cards]
    flush = len(set(suits)) == 1
    unique = sorted(set(values), reverse=True)
    straight_high: Optional[int] = None
    if len(unique) == 5 and unique[0] - unique[4] == 4:
        straight_high = unique[0]
    elif unique == [14, 5, 4, 3, 2]:
        straight_high = 5

    counts: dict[int, int] = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    groups = sorted(counts.items(), key=lambda x: (x[1], x[0]), reverse=True)

    if flush and straight_high:
        return (8, [straight_high], "straight flush")
    if groups[0][1] == 4:
        return (7, [groups[0][0], groups[1][0]], "four of a kind")
    if groups[0][1] == 3 and groups[1][1] == 2:
        return (6, [groups[0][0], groups[1][0]], "full house")
    if flush:
        return (5, values, "flush")
    if straight_high:
        return (4, [straight_high], "straight")
    if groups[0][1] == 3:
        return (3, [groups[0][0]] + sorted([g[0] for g in groups[1:]], reverse=True), "three of a kind")
    if groups[0][1] == 2 and groups[1][1] == 2:
        return (2, [groups[0][0], groups[1][0], groups[2][0]], "two pair")
    if groups[0][1] == 2:
        return (1, [groups[0][0]] + sorted([g[0] for g in groups[1:]], reverse=True), "pair")
    return (0, values, "high card")


def _compare_ranks(a: tuple, b: tuple) -> int:
    if a[0] != b[0]:
        return a[0] - b[0]
    for x, y in zip(a[1], b[1]):
        if x != y:
            return x - y
    return 0


def _showdown_rank(variant_name: str, hole: list[str], board: list[str]) -> tuple:
    all_cards = hole + board
    if variant_name == "highcard":
        return (0, [_RANK_VALUE.get(hole[0][0], 0)] if hole else [0], "high card")
    if len(all_cards) < 5:
        return (0, sorted([_RANK_VALUE.get(c[0], 0) for c in all_cards], reverse=True), "high card")
    best: Optional[tuple] = None
    for combo in combinations(all_cards, 5):
        rank = _evaluate5(list(combo))
        if best is None or _compare_ranks(rank, best) > 0:
            best = rank
    return best  # type: ignore[return-value]


def _resolve_showdown(t: Table) -> None:
    contenders = [t.seats[i] for i in _active_non_folded(t)]
    if not contenders:
        _finish_hand(t)
        return
    ranks = {
        p.seat_number: _showdown_rank(t.variant.variant_name, p.hole_cards, t.community_cards)
        for p in contenders
    }
    best = max(ranks.values(), key=lambda r: (r[0], r[1]))
    winners = [p for p in contenders if _compare_ranks(ranks[p.seat_number], best) == 0]
    pot = _total_pot(t)
    share = pot // len(winners)
    remainder = pot % len(winners)
    summary = []
    for p in winners:
        amount = share + (1 if remainder > 0 else 0)
        remainder -= 1
        p.chip_stack += amount
        label = ranks[p.seat_number][2] if ranks[p.seat_number] else ""
        summary.append({
            "seat_number": p.seat_number,
            "player_name": p.player_name,
            "amount": amount,
            "hand": label,
            "cards": p.hole_cards,
        })
        _append_log(t, "System", f"{p.player_name} wins {amount} with {label}")
    t.last_showdown = summary
    _finish_hand(t)


# ---------------------------------------------------------------------------
# AI decision-making
# ---------------------------------------------------------------------------

def _ai_name(level: str) -> str:
    return {"ai_easy": "Easy Bot", "ai_medium": "Medium Bot", "ai_hard": "Hard Bot"}.get(level, "AI Bot")


def _choose_ai_action(t: Table, actor: int) -> tuple[str, Optional[int]]:
    allowed = legal_actions_for_seat(t, actor)
    names = {a["action"] for a in allowed}
    if "check" in names:
        return "check", None
    if "call" in names:
        return ("fold", None) if random.random() < 0.15 else ("call", None)
    if "bet" in names and random.random() < 0.2:
        spec = next(a for a in allowed if a["action"] == "bet")
        return "bet", spec["min_total"]
    return "check", None


def _advance_ai_until_human(t: Table) -> None:
    guard = 0
    while t.hand_in_progress and not t.hand_complete and guard < 100:
        guard += 1
        actor = _current_actor(t)
        if actor is None:
            _advance_phase(t)
            continue
        p = t.seats[actor]
        if not p:
            t.players_to_act = t.players_to_act[1:]
            continue
        if p.ai_level == "human":
            break
        action, amt = _choose_ai_action(t, actor)
        apply_action(t, actor, action, amt, None)


# ---------------------------------------------------------------------------
# State serialization (viewer-specific projection for API response)
# ---------------------------------------------------------------------------

def seat_data(t: Table, p: Player, reveal: bool) -> dict:
    hand_label = ""
    if reveal and p.hole_cards and not p.folded:
        all_cards = p.hole_cards + t.community_cards
        if len(all_cards) >= 5:
            rank = _showdown_rank(t.variant.variant_name, p.hole_cards, t.community_cards)
            hand_label = rank[2] if rank else ""
    return {
        "seat_number": p.seat_number,
        "player_name": p.player_name,
        "ai_level": p.ai_level,
        "chip_stack": p.chip_stack,
        "current_bet": p.current_bet,
        "folded": p.folded,
        "all_in": p.all_in,
        "last_action": p.last_action or "",
        "hole_cards": (p.hole_cards or []) if reveal else [],
        "hand_label": hand_label,
    }


def serialize(room: Room, viewer_token: str = "", viewer_client_id: str = "",
              turn_timeout_ms: float = 30_000) -> dict:
    t = room.table
    viewer_seat = seat_for_token(t, viewer_token)
    recovered_token = ""
    if viewer_seat is None and viewer_client_id:
        recovered = seat_for_client_id(t, viewer_client_id)
        if recovered is not None:
            viewer_seat = recovered
            p = t.seats[recovered]
            recovered_token = p.token or "" if p else ""

    actor = _current_actor(t)
    turn_deadline = 0.0
    turn_secs_left = 0
    if actor is not None and t.turn_started_at:
        turn_deadline = t.turn_started_at + turn_timeout_ms
        turn_secs_left = max(0, int((turn_deadline - now_ms()) / 1000))

    from .store import has_redis
    return {
        "variant": t.variant.variant_name,
        "variant_display": t.variant.display_name,
        "pot": _total_pot(t),
        "street": _street_name(t) if t.hand_in_progress else t.status_message,
        "hand_id": t.hand_id,
        "hand_in_progress": bool(t.hand_in_progress),
        "hand_complete": bool(t.hand_complete),
        "status_message": t.status_message,
        "current_bet_to_call": t.current_bet_to_call,
        "current_actor_index": actor,
        "turn_started_at": t.turn_started_at or 0,
        "turn_deadline_at": turn_deadline,
        "turn_seconds_left": turn_secs_left,
        "viewer_seat": viewer_seat,
        "viewer_token_valid": viewer_seat is not None,
        "recovered_token": recovered_token,
        "legal_actions": legal_actions_for_seat(t, viewer_seat) if viewer_seat is not None else [],
        "max_seats": t.max_seats,
        "button_index": t.button_index,
        "community_cards": t.community_cards,
        "seats": [
            seat_data(t, p, t.hand_complete or i == viewer_seat) if p else None
            for i, p in enumerate(t.seats)
        ],
        "log": t.log,
        "showdown": t.last_showdown,
        "game_winner": t.game_winner,
        "room": room_summary(room),
        "default_room_id": "MAIN01",
        "realtime_mode": "vercel-redis-polling" if has_redis() else "temporary-file-polling",
    }


def mutation_payload(state: AppState, room: Room,
                     viewer_token: str = "", viewer_client_id: str = "",
                     turn_timeout_ms: float = 30_000) -> dict:
    return {
        "ok": True,
        "state": serialize(room, viewer_token, viewer_client_id, turn_timeout_ms),
        "rooms": rooms_payload(state),
    }
