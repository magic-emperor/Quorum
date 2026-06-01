"""
Database connection factory.

Chooses the backend based on environment variables:
  - TURSO_DATABASE_URL + TURSO_AUTH_TOKEN set  →  Turso cloud SQLite (libsql)
  - Otherwise                                  →  local aiosqlite file

Usage (identical to aiosqlite):
    from qorum.db import db_connect

    async with db_connect(path) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute(...)
        await conn.commit()

The local path argument is ignored when Turso is configured.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator


def db_backend() -> str:
    """Return 'turso' or 'sqlite'."""
    if os.environ.get("TURSO_DATABASE_URL") and os.environ.get("TURSO_AUTH_TOKEN"):
        return "turso"
    return "sqlite"


@asynccontextmanager
async def db_connect(path: Path) -> AsyncGenerator:
    """
    Async context manager returning a DB connection.
    Transparent drop-in for `aiosqlite.connect(path)`.
    """
    backend = db_backend()

    if backend == "turso":
        conn = await _turso_connect()
        try:
            yield conn
        finally:
            await conn.close()
    else:
        import aiosqlite
        path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(path) as conn:
            yield conn


async def _turso_connect():
    """Connect to Turso and return a connection with aiosqlite-compatible interface."""
    url = os.environ["TURSO_DATABASE_URL"]
    token = os.environ["TURSO_AUTH_TOKEN"]

    try:
        import libsql_experimental as libsql  # type: ignore[import]
    except ImportError as exc:
        raise ImportError(
            "Turso support requires: pip install libsql-experimental\n"
            "Or install with: pip install -e '.[cloud]'"
        ) from exc

    conn = libsql.connect(url, auth_token=token)
    return _TursoConnectionWrapper(conn)


class _TursoConnectionWrapper:
    """
    Wraps a libsql connection to match the aiosqlite interface used in approval/db.py.
    Provides: execute(), executescript(), fetchone(), fetchall(), commit(), close(),
    and row_factory assignment.
    """

    def __init__(self, conn) -> None:
        self._conn = conn
        self.row_factory = None

    async def execute(self, sql: str, params=()) -> "_TursoCursorWrapper":
        cursor = self._conn.execute(sql, params)
        return _TursoCursorWrapper(cursor, self.row_factory)

    async def executescript(self, sql: str) -> None:
        self._conn.executescript(sql)

    async def commit(self) -> None:
        self._conn.commit()

    async def close(self) -> None:
        pass  # libsql connections are not explicitly closed


class _TursoCursorWrapper:
    """Wraps a libsql cursor to match aiosqlite's async cursor interface."""

    def __init__(self, cursor, row_factory) -> None:
        self._cursor = cursor
        self._row_factory = row_factory

    async def fetchone(self):
        row = self._cursor.fetchone()
        if row is None:
            return None
        return _make_row(row, self._cursor.description, self._row_factory)

    async def fetchall(self):
        rows = self._cursor.fetchall()
        return [_make_row(r, self._cursor.description, self._row_factory) for r in rows]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass


def _make_row(raw_row, description, row_factory):
    """Convert a raw tuple row to an aiosqlite.Row-compatible dict-like object."""
    import aiosqlite
    if row_factory is aiosqlite.Row and description:
        # Build a dict-like row matching aiosqlite.Row behaviour
        keys = [col[0] for col in description]
        return _DictRow(dict(zip(keys, raw_row)))
    return raw_row


class _DictRow(dict):
    """Dict subclass that also supports index access, matching aiosqlite.Row."""
    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)
