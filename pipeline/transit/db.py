"""Tiny DuckDB helpers. DuckDB 2.x requires each result to be consumed before the next call."""

from __future__ import annotations

import duckdb


def q(con: duckdb.DuckDBPyConnection, sql: str, params=None) -> list[tuple]:
    cur = con.execute(sql) if params is None else con.execute(sql, params)
    try:
        return cur.fetchall()
    except duckdb.InvalidInputError:  # statement produced no result set
        return []


def df(con: duckdb.DuckDBPyConnection, sql: str, params=None):
    cur = con.execute(sql) if params is None else con.execute(sql, params)
    return cur.df()
