#!/usr/bin/env python3
"""Dump unciv_bot SQLite DB for diagnosing wrong-turn notifications.

Usage:
  python3 scripts/dump_db.py /path/to/subscriptions.db
  python3 scripts/dump_db.py ./data/subscriptions.db

Opens the DB read-only. Prints schema, settings, subscriptions (grouped by
game), game_state, and cross-check anomalies useful when notifications go to
the wrong person.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone


def ms_to_iso(ms: int | None) -> str:
    if ms is None:
        return "NULL"
    try:
        dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        return f"{dt.isoformat()} ({ms})"
    except (OSError, OverflowError, ValueError):
        return f"INVALID ({ms})"


def age_str(ms: int | None, now_ms: int) -> str:
    if ms is None:
        return "n/a"
    age_s = max(0, (now_ms - ms) // 1000)
    h, rem = divmod(age_s, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m ago"
    if m:
        return f"{m}m {s}s ago"
    return f"{s}s ago"


def qall(con: sqlite3.Connection, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    return list(con.execute(sql, args))


def section(title: str) -> None:
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def dump_schema(con: sqlite3.Connection) -> None:
    section("SCHEMA")
    tables = qall(
        con,
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    for row in tables:
        print(f"\n-- {row['name']}")
        print(row["sql"] or "(no sql)")
        cols = qall(con, f"PRAGMA table_info({row['name']})")
        for c in cols:
            print(f"   col: {c['name']:24} type={c['type']:10} notnull={c['notnull']} pk={c['pk']}")


def dump_settings(con: sqlite3.Connection) -> None:
    section("SETTINGS")
    rows = qall(con, "SELECT key, value FROM settings ORDER BY key")
    if not rows:
        print("(empty — env/defaults apply)")
        return
    for r in rows:
        print(f"  {r['key']} = {r['value']!r}")


def dump_admins_blocks(con: sqlite3.Connection) -> None:
    section("ADMINS")
    rows = qall(con, "SELECT username, chat_id FROM admins ORDER BY username")
    if not rows:
        print("(none)")
    for r in rows:
        print(f"  @{r['username']}  chat_id={r['chat_id']}")

    section("BLOCKLIST")
    users = qall(con, "SELECT username FROM blocked_usernames ORDER BY username")
    chats = qall(con, "SELECT chat_id FROM blocked_chats ORDER BY chat_id")
    print("  usernames:", ", ".join(f"@{u['username']}" for u in users) or "(none)")
    print("  chat_ids:", ", ".join(str(c["chat_id"]) for c in chats) or "(none)")


def dump_subscriptions(con: sqlite3.Connection) -> dict[str, list[sqlite3.Row]]:
    section("SUBSCRIPTIONS (grouped by game_id)")
    rows = qall(
        con,
        "SELECT chat_id, username, game_id, user_id FROM subscriptions ORDER BY game_id, chat_id, user_id",
    )
    by_game: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for r in rows:
        by_game[r["game_id"]].append(r)

    print(f"total rows: {len(rows)}")
    print(f"distinct games: {len(by_game)}")
    print(f"distinct chats: {len({r['chat_id'] for r in rows})}")
    print(f"distinct user_ids: {len({r['user_id'] for r in rows})}")

    for game_id, subs in by_game.items():
        print(f"\n  game_id={game_id}")
        print(f"    subscribers: {len(subs)}")
        for s in subs:
            uname = f"@{s['username']}" if s["username"] else "(no username)"
            print(f"    - chat_id={s['chat_id']:<16} {uname:<24} user_id={s['user_id']}")

        # Same chat subscribed to multiple Unciv user_ids in this game?
        by_chat: dict[int, list[str]] = defaultdict(list)
        for s in subs:
            by_chat[s["chat_id"]].append(s["user_id"])
        multi = {cid: uids for cid, uids in by_chat.items() if len(uids) > 1}
        if multi:
            print("    NOTE: chat(s) subscribed to multiple user_ids in this game:")
            for cid, uids in multi.items():
                print(f"      chat_id={cid}: {uids}")

        # Same Unciv user_id registered in multiple chats?
        by_uid: dict[str, list[int]] = defaultdict(list)
        for s in subs:
            by_uid[s["user_id"]].append(s["chat_id"])
        shared = {uid: chats for uid, chats in by_uid.items() if len(chats) > 1}
        if shared:
            print("    NOTE: user_id(s) registered in multiple chats:")
            for uid, chats in shared.items():
                print(f"      user_id={uid}: chats={chats}")

    return by_game


def dump_game_state(con: sqlite3.Connection, by_game: dict[str, list[sqlite3.Row]]) -> None:
    section("GAME_STATE (last seen turn + last notify)")
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    cols = {c["name"] for c in qall(con, "PRAGMA table_info(game_state)")}
    has_notified = "last_notified_at" in cols

    if has_notified:
        rows = qall(
            con,
            "SELECT game_id, last_turns, last_current_player, last_notified_at "
            "FROM game_state ORDER BY game_id",
        )
    else:
        rows = qall(
            con,
            "SELECT game_id, last_turns, last_current_player FROM game_state ORDER BY game_id",
        )
        print("WARNING: last_notified_at column missing (pre-migration DB?)")

    if not rows:
        print("(empty)")
        return

    for r in rows:
        print(f"\n  game_id={r['game_id']}")
        print(f"    last_turns={r['last_turns']}  last_current_player={r['last_current_player']!r}")
        if has_notified:
            ln = r["last_notified_at"]
            print(f"    last_notified_at={ms_to_iso(ln)}  ({age_str(ln, now_ms)})")
        subs = by_game.get(r["game_id"], [])
        if not subs:
            print("    WARNING: game_state row with NO subscriptions")
        else:
            uids = ", ".join(sorted({s["user_id"] for s in subs}))
            print(f"    subscribed user_ids: {uids}")
            print("    (bot notifies when preview.currentPlayer civ's playerId is one of these)")


def dump_cross_checks(con: sqlite3.Connection, by_game: dict[str, list[sqlite3.Row]]) -> None:
    section("CROSS-CHECKS (anomalies)")
    state_ids = {r["game_id"] for r in qall(con, "SELECT game_id FROM game_state")}
    sub_ids = set(by_game)

    missing_state = sorted(sub_ids - state_ids)
    orphan_state = sorted(state_ids - sub_ids)

    if missing_state:
        print("games with subscriptions but no game_state (never polled / first cycle pending):")
        for g in missing_state:
            print(f"  - {g}")
    else:
        print("games with subscriptions but no game_state: (none)")

    if orphan_state:
        print("\ngame_state rows with no subscriptions (orphan; should be rare):")
        for g in orphan_state:
            print(f"  - {g}")
    else:
        print("\ngame_state orphans: (none)")

    # Duplicate (chat_id, game_id) with different user_ids — common source of "wrong person"
    # if someone subscribed their opponent's UUID by mistake.
    print("\nchats with >1 user_id under the same game (possible mix-up):")
    found = False
    for game_id, subs in by_game.items():
        by_chat: dict[int, set[str]] = defaultdict(set)
        for s in subs:
            by_chat[s["chat_id"]].add(s["user_id"])
        for chat_id, uids in by_chat.items():
            if len(uids) > 1:
                found = True
                uname = next((s["username"] for s in subs if s["chat_id"] == chat_id), "")
                label = f"@{uname}" if uname else "(no username)"
                print(f"  chat_id={chat_id} {label} game={game_id}")
                for uid in sorted(uids):
                    print(f"    user_id={uid}")
    if not found:
        print("  (none)")

    # Same user_id appearing under different usernames
    print("\nuser_ids claimed by multiple telegram usernames:")
    uid_names: dict[str, set[str]] = defaultdict(set)
    for subs in by_game.values():
        for s in subs:
            if s["username"]:
                uid_names[s["user_id"]].add(s["username"])
    multi_names = {uid: names for uid, names in uid_names.items() if len(names) > 1}
    if multi_names:
        for uid, names in sorted(multi_names.items()):
            print(f"  user_id={uid}: {sorted(names)}")
    else:
        print("  (none)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("db_path", help="Path to subscriptions.db")
    args = parser.parse_args()

    path = os.path.abspath(args.db_path)
    if not os.path.isfile(path):
        print(f"error: file not found: {path}", file=sys.stderr)
        return 1

    # Read-only URI so we never mutate a live DB (works even if WAL is open).
    uri = f"file:{path}?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as e:
        print(f"error: cannot open DB: {e}", file=sys.stderr)
        return 1

    con.row_factory = sqlite3.Row
    print(f"DB: {path}")
    print(f"size: {os.path.getsize(path)} bytes")
    print(f"opened: read-only at {datetime.now(tz=timezone.utc).isoformat()}")

    try:
        dump_schema(con)
        dump_settings(con)
        dump_admins_blocks(con)
        by_game = dump_subscriptions(con)
        dump_game_state(con, by_game)
        dump_cross_checks(con, by_game)
    finally:
        con.close()

    print()
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
