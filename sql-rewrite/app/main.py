"""L6 SQL-rewrite microservice (ARCHITECTURE.md §10.3).

Stateless, horizontally scalable. POST /rewrite
  {sql, dialect, row_filters[], column_policies[]} -> {sql}
The Go BFF calls this between policy resolution and engine execution (§10.2).
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .rewrite import rewrite_sql

app = FastAPI(title="ipas-sql-rewrite", version="0.1.0")


class ColumnPolicy(BaseModel):
    column: str
    mask_type: str = "none"  # deny|full|partial|hash|none
    mask_expr: str | None = None


class RewriteRequest(BaseModel):
    sql: str
    dialect: str = Field(default="trino")  # trino|clickhouse
    row_filters: list[str] = Field(default_factory=list)
    column_policies: list[ColumnPolicy] = Field(default_factory=list)


class RewriteResponse(BaseModel):
    sql: str


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/rewrite", response_model=RewriteResponse)
def rewrite(req: RewriteRequest) -> RewriteResponse:
    try:
        out = rewrite_sql(
            sql=req.sql,
            dialect=req.dialect,
            row_filters=req.row_filters,
            column_policies=[p.model_dump() for p in req.column_policies],
        )
    except Exception as exc:  # noqa: BLE001 — surface parse/rewrite errors as 400
        raise HTTPException(status_code=400, detail=f"rewrite failed: {exc}") from exc
    return RewriteResponse(sql=out)
