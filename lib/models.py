"""Pydantic models for the poker platform — rooms, tables, players, API I/O."""
from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Internal domain models (stored in Redis / local file)
# ---------------------------------------------------------------------------

class Variant(BaseModel):
    variant_name: str
    display_name: str
    min_players: int
    default_starting_stack: int
    hole_cards: int
    cards_per_round: list[int]
    uses_blinds: bool
    small_blind: int
    big_blind: int
    ante: int
    min_open_bet: int


class Player(BaseModel):
    seat_number: int
    player_name: str
    ai_level: str
    token: Optional[str] = None
    client_id: Optional[str] = None
    last_seen_at: Optional[float] = None
    chip_stack: int = 0
    hole_cards: list[str] = Field(default_factory=list)
    current_bet: int = 0
    chips_in_pot: int = 0
    folded: bool = False
    all_in: bool = False
    acted_this_round: bool = False
    eliminated: bool = False
    last_action: str = ""


class Table(BaseModel):
    variant: Variant
    max_seats: int
    seats: list[Optional[Player]]
    hand_id: int = 0
    button_index: int = -1
    community_cards: list[str] = Field(default_factory=list)
    deck: list[str] = Field(default_factory=list)
    street_index: int = 0
    current_hand_seed: Optional[int] = None
    current_bet_to_call: int = 0
    min_raise_increment: int = 10
    players_to_act: list[int] = Field(default_factory=list)
    turn_actor_index: Optional[int] = None
    turn_started_at: float = 0.0
    hand_in_progress: bool = False
    hand_complete: bool = False
    status_message: str = "Waiting for players"
    log: list[dict[str, Any]] = Field(default_factory=list)
    last_showdown: list[dict[str, Any]] = Field(default_factory=list)
    game_winner: Optional[dict[str, Any]] = None


class Room(BaseModel):
    room_id: str
    name: str
    table: Table
    created_at: float
    last_activity_at: float
    is_default: bool = False
    creator_token: str = ""
    creator_client_id: str = ""


class AppState(BaseModel):
    version: int = 2
    default_room_id: str = "MAIN01"
    rooms: dict[str, Room] = Field(default_factory=dict)
    updated_at: float = 0.0


# ---------------------------------------------------------------------------
# Request body models (validated by FastAPI)
# ---------------------------------------------------------------------------

class CreateRoomBody(BaseModel):
    name: str = "Poker Table"
    variant: str = "holdem"
    max_seats: int = 6
    client_id: str = ""
    player_name: str = ""
    auto_join: bool = False


class JoinBody(BaseModel):
    room_id: str = ""
    name: str = ""
    ai_level: str = "human"
    client_id: str = ""
    seat_index: Optional[int] = None


class AutoJoinBody(BaseModel):
    room_id: str = ""
    name: str = ""
    client_id: str = ""


class ActionBody(BaseModel):
    room_id: str = ""
    token: str = ""
    client_id: str = ""
    action: str = ""
    amount: Optional[float] = None


class AddAiBody(BaseModel):
    room_id: str = ""
    seat_index: int = 0
    ai_level: str = "ai_easy"
    name: str = ""
    token: str = ""
    client_id: str = ""


class SimpleRoomBody(BaseModel):
    room_id: str = ""
    token: str = ""
    client_id: str = ""


class KickBody(BaseModel):
    room_id: str = ""
    seat_index: int = 0
    creator_token: str = ""
    token: str = ""
    client_id: str = ""


class CloseRoomBody(BaseModel):
    room_id: str = ""
    creator_token: str = ""


class HeartbeatBody(BaseModel):
    room_id: str = ""
    token: str = ""
    client_id: str = ""
