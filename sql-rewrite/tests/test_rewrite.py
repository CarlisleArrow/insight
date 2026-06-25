"""Unit tests for L6 rewrite: row-filter injection + each mask_type, per dialect."""
import sqlglot

from app.rewrite import rewrite_sql


def _norm(sql: str) -> str:
    """Normalize for comparison: parse + re-render, lowercase, collapse spaces."""
    return " ".join(sqlglot.parse_one(sql).sql().lower().split())


def test_row_filter_injected_when_no_where():
    out = rewrite_sql(
        "SELECT process_id, result_value FROM gold_qms.fact_chemical_results",
        dialect="trino",
        row_filters=["process_id IN ('P1','P2')"],
    )
    low = out.lower()
    assert "where" in low
    assert "process_id in ('p1', 'p2')" in low


def test_row_filter_anded_with_existing_where():
    out = rewrite_sql(
        "SELECT process_id FROM gold_qms.x WHERE result_value > 10",
        dialect="trino",
        row_filters=["process_id IN ('P1')"],
    )
    low = out.lower()
    assert "result_value > 10" in low
    assert "process_id in ('p1')" in low
    assert " and " in low


def test_multiple_row_filters_combined():
    out = rewrite_sql(
        "SELECT a FROM gold_qms.x",
        dialect="trino",
        row_filters=["a > 1", "b < 5"],
    ).lower()
    assert "a > 1" in out and "b < 5" in out and " and " in out


def test_mask_deny_projects_null():
    out = rewrite_sql(
        "SELECT process_id, result_value FROM silver_qms.t",
        dialect="trino",
        column_policies=[{"column": "result_value", "mask_type": "deny"}],
    ).lower()
    assert "null as result_value" in out
    assert "process_id" in out


def test_mask_full_projects_constant():
    out = rewrite_sql(
        "SELECT email FROM silver_qms.customers",
        dialect="trino",
        column_policies=[{"column": "email", "mask_type": "full"}],
    ).lower()
    assert "'***' as email" in out


def test_mask_hash_trino():
    out = rewrite_sql(
        "SELECT email FROM silver_qms.customers",
        dialect="trino",
        column_policies=[{"column": "email", "mask_type": "hash"}],
    ).lower()
    assert "sha256" in out and "as email" in out


def test_mask_hash_clickhouse():
    out = rewrite_sql(
        "SELECT email FROM gold_qms.customers",
        dialect="clickhouse",
        column_policies=[{"column": "email", "mask_type": "hash"}],
    ).lower()
    assert "sha256" in out and "as email" in out


def test_mask_partial_template():
    out = rewrite_sql(
        "SELECT phone FROM silver_qms.customers",
        dialect="trino",
        column_policies=[
            {"column": "phone", "mask_type": "partial", "mask_expr": "concat(substr({col}, 1, 3), '****')"}
        ],
    ).lower()
    # sqlglot may render substr as substring depending on dialect; assert the
    # column + literal survived and the output alias is preserved.
    assert "phone" in out and "****" in out and "as phone" in out


def test_combined_row_and_column():
    out = rewrite_sql(
        "SELECT process_id, result_value FROM gold_qms.fact_chemical_results WHERE judgment = 'OK'",
        dialect="clickhouse",
        row_filters=["process_id IN ('P1')"],
        column_policies=[{"column": "result_value", "mask_type": "full"}],
    ).lower()
    assert "'***' as result_value" in out
    assert "process_id in ('p1')" in out
    assert "judgment = 'ok'" in out


def test_unmasked_passthrough():
    src = "SELECT a, b FROM gold_qms.t"
    out = rewrite_sql(src, dialect="trino")
    assert _norm(out) == _norm(src)
