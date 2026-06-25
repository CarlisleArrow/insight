"""L6 SQL-rewrite core (ARCHITECTURE.md §10.2/§10.3).

Given a raw SELECT, a set of row filters, and per-column masking policies, produce
dialect-correct rewritten SQL:
  * row filters are AND-combined and injected into (or appended to) the WHERE clause;
  * masked columns are rewritten in the projection:
        deny    -> NULL
        full    -> a constant '***'
        hash    -> sha256(col)  (engine-native; pushed down)
        partial -> caller-supplied mask_expr template ({col} placeholder)
        none    -> untouched

Masking executes INSIDE the engine (§10.2) — we only transform SQL, never data.
"""
from __future__ import annotations

from typing import Any

import sqlglot
from sqlglot import exp

# Map our dialect names to sqlglot's.
_DIALECT = {"trino": "trino", "clickhouse": "clickhouse"}


def _hash_expr(dialect: str, col: exp.Expression) -> exp.Expression:
    """Engine-native sha256 of a column, cast to text first for stability."""
    text = exp.cast(col, "varchar")
    if dialect == "clickhouse":
        # ClickHouse: hex(SHA256(s)) keeps it printable.
        return exp.func("hex", exp.func("SHA256", text))
    # Trino: to_hex(sha256(cast as varbinary)).
    return exp.func("to_hex", exp.func("sha256", exp.cast(text, "varbinary")))


def _mask_projection(node: exp.Expression, policies: dict[str, dict], dialect: str) -> None:
    """Rewrite SELECT projections in-place according to column policies.

    Only bare column references / aliased columns whose underlying name is masked
    are rewritten; the output alias is preserved so result shape is unchanged.
    A `SELECT *` cannot be masked safely and is left untouched (caller should
    expand columns upstream; tracked as a guardrail).
    """
    for select in node.find_all(exp.Select):
        new_projections = []
        for proj in select.expressions:
            col_name = _projection_column_name(proj)
            pol = policies.get(col_name) if col_name else None
            if not pol:
                new_projections.append(proj)
                continue
            masked = _apply_mask(col_name, pol, dialect)
            # Preserve the original output name.
            alias = proj.alias_or_name or col_name
            new_projections.append(exp.alias_(masked, alias))
        select.set("expressions", new_projections)


def _projection_column_name(proj: exp.Expression) -> str | None:
    """Return the underlying column name of a projection, or None for *, literals, complex exprs."""
    target = proj.this if isinstance(proj, exp.Alias) else proj
    if isinstance(target, exp.Column):
        return target.name
    return None


def _apply_mask(col_name: str, pol: dict, dialect: str) -> exp.Expression:
    mask_type = (pol.get("mask_type") or "none").lower()
    col = exp.column(col_name)
    if mask_type == "deny":
        return exp.Null()
    if mask_type == "full":
        return exp.Literal.string("***")
    if mask_type == "hash":
        return _hash_expr(dialect, col)
    if mask_type == "partial":
        template = pol.get("mask_expr") or "{col}"
        # Parse the template with {col} substituted, in the target dialect.
        return sqlglot.parse_one(template.replace("{col}", col_name), read=_DIALECT.get(dialect, dialect))
    return col


def _inject_row_filters(node: exp.Expression, row_filters: list[str], dialect: str) -> None:
    """AND-combine row filters into every SELECT's WHERE clause.

    Select.where(..., append=True) ANDs each predicate with any existing WHERE,
    so both the no-WHERE and existing-WHERE cases are handled uniformly.
    """
    if not row_filters:
        return
    read = _DIALECT.get(dialect, dialect)
    parsed = [sqlglot.parse_one(f, read=read) for f in row_filters if f and f.strip()]
    if not parsed:
        return
    for select in node.find_all(exp.Select):
        for pf in parsed:
            select.where(pf.copy(), append=True, copy=False)


def rewrite_sql(
    sql: str,
    dialect: str,
    row_filters: list[str] | None = None,
    column_policies: list[dict[str, Any]] | None = None,
) -> str:
    """Top-level entry: parse, mask projection, inject filters, re-render."""
    read = _DIALECT.get(dialect, dialect)
    tree = sqlglot.parse_one(sql, read=read)

    policies = {
        p["column"]: p
        for p in (column_policies or [])
        if p.get("column") and (p.get("mask_type") or "none").lower() != "none"
    }
    if policies:
        _mask_projection(tree, policies, dialect)
    _inject_row_filters(tree, row_filters or [], dialect)

    return tree.sql(dialect=read)
