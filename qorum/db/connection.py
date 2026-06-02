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

# Load .env from root or qorum/ directory on import
def _load_env() -> None:
    try:
        from dotenv import load_dotenv
        for candidate in (Path(__file__).parents[2] / ".env",
                          Path(__file__).parents[2] / "qorum" / ".env"):
            if candidate.exists():
                load_dotenv(candidate, override=False)
    except ImportError:
        pass

_load_env()


def _turso_url() -> str:
    """Return Turso DB URL, accepting both TURSO_DATABASE_URL and TURSO_DB."""
    return os.environ.get("TURSO_DATABASE_URL") or os.environ.get("TURSO_DB", "")


def _turso_token() -> str:
    """Return Turso auth token, accepting both TURSO_AUTH_TOKEN and TURSO_TOKEN."""
    return os.environ.get("TURSO_AUTH_TOKEN") or os.environ.get("TURSO_TOKEN", "")


def db_backend() -> str:
    """Return 'turso' or 'sqlite'."""
    if _turso_url() and _turso_token():
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
    """
    Connect to Turso using libsql-client (pure HTTP — no Rust/CMake compilation needed).
    pip install libsql-client
    """
    url = _turso_url()
    token = _turso_token()

    try:
        import libsql_client  # type: ignore[import]
    except ImportError as exc:
        raise ImportError(
            "Turso support requires: pip install libsql-client\n"
            "Or install with: pip install -e '.[cloud]'"
        ) from exc

    # libsql-client needs https:// — convert libsql:// prefix if present
    http_url = url.replace("libsql://", "https://", 1)
    client = libsql_client.create_client(url=http_url, auth_token=token)
    return _TursoConnectionWrapper(client)


class _TursoConnectionWrapper:
    """
    Wraps a libsql_client.Client to match the aiosqlite interface used in approval/db.py.
    Buffers statements within a logical transaction and sends them on commit().
    """

    def __init__(self, client) -> None:
        self._client = client
        self._pending: list[tuple[str, tuple]] = []
        self.row_factory = None
        self._last_result = None

    async def execute(self, sql: str, params=()) -> "_TursoCursorWrapper":
        # For SELECT we execute immediately; for mutations we buffer until commit()
        sql_upper = sql.strip().upper()
        if sql_upper.startswith("SELECT") or sql_upper.startswith("PRAGMA"):
            import libsql_client
            stmt = libsql_client.Statement(sql, list(params))
            result = await self._client.execute(stmt)
            return _TursoCursorWrapper(result, self.row_factory)
        else:
            self._pending.append((sql, params))
            return _TursoCursorWrapper(None, self.row_factory)

    async def executescript(self, sql: str) -> None:
        # Split on semicolons and buffer each statement
        for stmt in sql.split(";"):
            stmt = stmt.strip()
            if stmt:
                self._pending.append((stmt, ()))

    async def commit(self) -> None:
        if not self._pending:
            return
        import libsql_client
        stmts = [libsql_client.Statement(sql, list(params))
                 for sql, params in self._pending]
        await self._client.batch(stmts)
        self._pending.clear()

    async def close(self) -> None:
        try:
            await self._client.close()
        except Exception:
            pass


class _TursoCursorWrapper:
    """Wraps a libsql_client ResultSet to match aiosqlite's async cursor interface."""

    def __init__(self, result, row_factory) -> None:
        self._result = result
        self._row_factory = row_factory

    async def fetchone(self):
        if not self._result or not self._result.rows:
            return None
        return _make_row(self._result.rows[0], self._result.columns, self._row_factory)

    async def fetchall(self):
        if not self._result or not self._result.rows:
            return []
        return [_make_row(r, self._result.columns, self._row_factory)
                for r in self._result.rows]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass


def _make_row(raw_row, columns, row_factory):
    """Convert a raw row to an aiosqlite.Row-compatible dict-like object.
    columns: list of column name strings (libsql_client) or DBAPI description tuples (aiosqlite).
    """
    import aiosqlite
    if row_factory is aiosqlite.Row and columns:
        keys = [c if isinstance(c, str) else c[0] for c in columns]
        return _DictRow(dict(zip(keys, raw_row)))
    return raw_row


class _DictRow(dict):
    """Dict subclass that also supports index access, matching aiosqlite.Row."""
    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)
