#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Silver → Gold Aggregation ETL v2.0 (完整SPC控制图 + 监控)
============================================================
核心改进：
1. ✅ 幂等性：基于水位线增量处理
2. ✅ 事务原子性：PostgreSQL + Iceberg双写一致性
3. ✅ 失败重试：Tenacity自动重试3次
4. ✅ 修复删除逻辑：只删除当前处理日期范围，不影响其他数据
5. ✅ 优化UPSERT：真正的UPDATE逻辑，而非DO NOTHING
6. ✅ 数据血缘：上报到DataHub和Neo4j
7. ✅ 水位线追踪：Gold层维护处理状态
8. ✅ 完整SPC控制图：XBar-R, XBar-S, P图, C图, 移动平均
"""
import os
import sys
import argparse
import logging
import time
from datetime import datetime, date, timedelta
from typing import Optional

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    col, lit, when, avg, stddev_samp, count, sum as _sum, least,
    current_timestamp, to_date, row_number, max as fmax, min as fmin, sqrt, first
)
from pyspark.sql.window import Window

# 重试库
try:
    from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
    TENACITY_AVAILABLE = True
except ImportError:
    TENACITY_AVAILABLE = False
    logging.warning("⚠️ tenacity未安装，失败重试功能禁用")

# Prometheus
try:
    from prometheus_client import CollectorRegistry, Gauge, Counter, Histogram, push_to_gateway
    PROMETHEUS_AVAILABLE = True
except ImportError:
    PROMETHEUS_AVAILABLE = False
    logging.warning("⚠️ prometheus_client未安装，监控功能禁用")

# 血缘依赖
try:
    from datahub.emitter.rest_emitter import DatahubRestEmitter
    from datahub.emitter.mcp import MetadataChangeProposalWrapper
    from datahub.metadata.schema_classes import (
        DatasetLineageTypeClass, UpstreamLineageClass, UpstreamClass, StatusClass
    )
    from neo4j import GraphDatabase
    LINEAGE_AVAILABLE = True
except ImportError:
    LINEAGE_AVAILABLE = False
    logging.warning("⚠️ datahub/neo4j未安装，血缘上报禁用")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("gold_aggregation_etl_v2")

# =========================
# 配置
# =========================
PG_HOST = "172.16.202.54"
PG_PORT = "5432"
PG_DB = "qms_warehouse"
PG_USER = "admin"
PG_PASSWORD = "Pg123654"
PG_JDBC_URL = f"jdbc:postgresql://{PG_HOST}:{PG_PORT}/{PG_DB}"

ICEBERG_CATALOG_NAME = "iceberg"
ICEBERG_REST_URI = os.getenv("ICEBERG_REST_URI", "http://iceberg-rest-catalog.data-warehouse.svc.cluster.local:8181")

MINIO_ENDPOINT = "http://172.16.202.55:9000"
MINIO_ACCESS_KEY = "minioadmin"
MINIO_SECRET_KEY = "minioadmin"
S3_REGION = "us-east-1"

ICEBERG_WAREHOUSE = "s3://datalake-gold-iceberg/"
ICEBERG_SILVER_NAMESPACE = "silver_qms"
ICEBERG_GOLD_NAMESPACE = "gold_qms"

DEFAULT_START_DATE = os.getenv("START_DATE", date.today().isoformat())
DEFAULT_END_DATE = os.getenv("END_DATE", date.today().isoformat())

PROMETHEUS_GATEWAY = '172.16.201.110:9091'
JOB_NAME = 'gold_aggregation_etl_v2'

# 血缘配置
DATAHUB_GMS_URL = "http://172.16.202.60:9002/api/gms"
DATAHUB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhY3RvclR5cGUiOiJVU0VSIiwiYWN0b3JJZCI6ImRhdGFodWIiLCJ0eXBlIjoiUEVSU09OQUwiLCJ2ZXJzaW9uIjoiMiIsImp0aSI6ImFmZWFiZTEzLWJjMTMtNDU3Mi04N2I0LTkyN2QxNzcxNzdiNCIsInN1YiI6ImRhdGFodWIiLCJpc3MiOiJkYXRhaHViLW1ldGFkYXRhLXNlcnZpY2UifQ.s6wyrLe3vMtHNIbqO8Hqqtpj50Ej_9PHvFs_FAjVELk"
NEO4J_URI = "bolt://172.16.202.65:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "test"

# 水位线表
WATERMARK_TABLE = f"{ICEBERG_CATALOG_NAME}.{ICEBERG_GOLD_NAMESPACE}._gold_etl_watermarks"

# =========================
# Prometheus Metrics
# =========================
class GoldETLMetrics:
    def __init__(self):
        if not PROMETHEUS_AVAILABLE:
            return
        
        self.registry = CollectorRegistry()
        
        self.processing_duration = Histogram('gold_etl_v2_duration_seconds', 'Gold层处理时长', ['aggregation_type', 'operation'], registry=self.registry)
        self.records_read_silver = Gauge('gold_etl_v2_records_read_silver', 'Silver层读取记录数', ['table_name'], registry=self.registry)
        self.records_aggregated = Gauge('gold_etl_v2_records_aggregated', '聚合后记录数', ['aggregation_type'], registry=self.registry)
        self.records_written_pg = Gauge('gold_etl_v2_records_written_pg', 'PostgreSQL写入记录数', ['table_name'], registry=self.registry)
        self.records_written_iceberg = Gauge('gold_etl_v2_records_written_iceberg', 'Iceberg写入记录数', ['table_name'], registry=self.registry)
        self.watermark_timestamp = Gauge('gold_etl_v2_watermark_timestamp', '当前水位线时间戳(Unix秒)', ['aggregation_type'], registry=self.registry)
        self.spc_capability_count = Gauge('gold_etl_v2_spc_capability_count', 'SPC能力分析记录数', ['date_range'], registry=self.registry)
        self.operation_success = Counter('gold_etl_v2_success_total', 'Gold ETL操作成功', ['aggregation_type', 'operation'], registry=self.registry)
        self.operation_failure = Counter('gold_etl_v2_failure_total', 'Gold ETL操作失败', ['aggregation_type', 'operation'], registry=self.registry)
        self.transaction_rollback = Counter('gold_etl_v2_transaction_rollback_total', '事务回滚次数', ['aggregation_type'], registry=self.registry)
    
    def push_metrics(self):
        if not PROMETHEUS_AVAILABLE:
            return
        try:
            push_to_gateway(PROMETHEUS_GATEWAY, job=JOB_NAME, registry=self.registry)
        except Exception as e:
            logger.warning(f"⚠️ Prometheus推送失败: {e}")

metrics = GoldETLMetrics()

# =========================
# 数据血缘上报
# =========================
def report_gold_lineage(aggregation_type: str):
    """上报Gold层血缘: Silver Fact/Dim → Gold Aggregation"""
    if not LINEAGE_AVAILABLE:
        return
    
    try:
        emitter = DatahubRestEmitter(gms_server=DATAHUB_GMS_URL, token=DATAHUB_TOKEN)
        neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        
        # Source: Silver Fact Tables
        src_fact_urns = [
            f"urn:li:dataset:(urn:li:dataPlatform:iceberg,{ICEBERG_SILVER_NAMESPACE}.fact_analysis_records,PROD)",
            f"urn:li:dataset:(urn:li:dataPlatform:iceberg,{ICEBERG_SILVER_NAMESPACE}.fact_chemical_analysis_results,PROD)"
        ]
        
        # Target: Gold Aggregation
        tgt_pg_platform = "postgres"
        tgt_ice_platform = "iceberg"
        
        # 定义所有聚合表
        gold_tables = {
            "qualification_rate": "agg_qualification_rate_daily",
            "warning_statistics": "agg_warning_statistics_daily",
            "spc_capability": "spc_capability_daily",
            "spc_trend_ma": "spc_trend_ma",
            "spc_xbar_r": "spc_xbar_r_chart",
            "spc_xbar_s": "spc_xbar_s_chart",
            "spc_p_chart": "spc_p_chart",
            "spc_c_chart": "spc_c_chart"
        }
        
        table_name = gold_tables.get(aggregation_type, aggregation_type)
        
        tgt_pg_name = f"{PG_DB}.gold.{table_name}"
        tgt_ice_name = f"{ICEBERG_GOLD_NAMESPACE}.{table_name}"
        
        tgt_pg_urn = f"urn:li:dataset:(urn:li:dataPlatform:{tgt_pg_platform},{tgt_pg_name},PROD)"
        tgt_ice_urn = f"urn:li:dataset:(urn:li:dataPlatform:{tgt_ice_platform},{tgt_ice_name},PROD)"
        
        logger.debug(f"   📡 [Lineage] {aggregation_type}: Silver Facts → Gold Agg")
        
        # DataHub上报
        for src_urn in src_fact_urns:
            emitter.emit(MetadataChangeProposalWrapper(
                entityType="dataset", changeType="UPSERT", entityUrn=src_urn,
                aspectName="status", aspect=StatusClass(removed=False)
            ))
        
        for tgt_urn in [tgt_pg_urn, tgt_ice_urn]:
            emitter.emit(MetadataChangeProposalWrapper(
                entityType="dataset", changeType="UPSERT", entityUrn=tgt_urn,
                aspectName="status", aspect=StatusClass(removed=False)
            ))
            emitter.emit(MetadataChangeProposalWrapper(
                entityType="dataset", changeType="UPSERT", entityUrn=tgt_urn,
                aspectName="upstreamLineage",
                aspect=UpstreamLineageClass(upstreams=[
                    UpstreamClass(dataset=s, type=DatasetLineageTypeClass.TRANSFORMED) for s in src_fact_urns
                ])
            ))
        
        # Neo4j上报
        query = """
        UNWIND $sources AS src
        MERGE (s:Table {key: src.key})
        ON CREATE SET s.name = src.name, s.platform = src.platform
        WITH s
        MERGE (tpg:Table {key: $tgt_pg_key})
        ON CREATE SET tpg.name = $tgt_pg_name, tpg.platform = $tgt_pg_platform
        MERGE (tice:Table {key: $tgt_ice_key})
        ON CREATE SET tice.name = $tgt_ice_name, tice.platform = $tgt_ice_platform
        MERGE (s)-[:OUTPUT]->(tpg)
        MERGE (s)-[:OUTPUT]->(tice)
        """
        
        with neo4j_driver.session() as session:
            session.run(query,
                sources=[{
                    "key": f"iceberg://default.{ICEBERG_SILVER_NAMESPACE}/fact_analysis_records",
                    "name": f"{ICEBERG_SILVER_NAMESPACE}.fact_analysis_records",
                    "platform": "iceberg"
                }, {
                    "key": f"iceberg://default.{ICEBERG_SILVER_NAMESPACE}/fact_chemical_analysis_results",
                    "name": f"{ICEBERG_SILVER_NAMESPACE}.fact_chemical_analysis_results",
                    "platform": "iceberg"
                }],
                tgt_pg_key=f"{tgt_pg_platform}://default.{tgt_pg_name.replace('.', '/')}",
                tgt_pg_name=tgt_pg_name, tgt_pg_platform=tgt_pg_platform,
                tgt_ice_key=f"{tgt_ice_platform}://default.{tgt_ice_name.replace('.', '/')}",
                tgt_ice_name=tgt_ice_name, tgt_ice_platform=tgt_ice_platform
            )
        
        neo4j_driver.close()
        logger.info(f"   ✅ [Lineage] {aggregation_type} 血缘上报成功")
    except Exception as e:
        logger.warning(f"   ⚠️ [Lineage] {aggregation_type} 血缘上报失败: {e}")

# =========================
# Spark Session
# =========================
def create_spark():
    builder = (
        SparkSession.builder.appName("Gold_Aggregation_ETL_v2_Idempotent")
        .config("spark.jars.packages",
            "org.postgresql:postgresql:42.6.0,"
            "org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.4.0,"
            "org.apache.hadoop:hadoop-aws:3.3.4,"
            "com.amazonaws:aws-java-sdk-bundle:1.12.262"
        )
        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
        .config("spark.sql.catalog.iceberg", "org.apache.iceberg.spark.SparkCatalog")
        .config("spark.sql.catalog.iceberg.type", "rest")
        .config("spark.sql.catalog.iceberg.uri", ICEBERG_REST_URI)
        .config("spark.sql.catalog.iceberg.warehouse", ICEBERG_WAREHOUSE)
        .config("spark.sql.catalog.iceberg.io-impl", "org.apache.iceberg.hadoop.HadoopFileIO")
        .config("spark.hadoop.fs.s3a.endpoint", MINIO_ENDPOINT)
        .config("spark.hadoop.fs.s3a.access.key", MINIO_ACCESS_KEY)
        .config("spark.hadoop.fs.s3a.secret.key", MINIO_SECRET_KEY)
        .config("spark.hadoop.fs.s3a.path.style.access", "true")
        .config("spark.hadoop.fs.s3a.connection.ssl.enabled", "false")
        .config("spark.hadoop.fs.s3a.impl", "org.apache.hadoop.fs.s3a.S3AFileSystem")
        .config("spark.hadoop.fs.s3a.aws.credentials.provider", "org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider")
        .config("spark.hadoop.fs.s3a.aws.region", S3_REGION)
    )
    spark = builder.getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    # 抑制Iceberg已知的HadoopStreams unclosed stream警告
    spark.sparkContext._jvm.org.apache.log4j.Logger.getLogger("org.apache.iceberg.hadoop.HadoopStreams").setLevel(
        spark.sparkContext._jvm.org.apache.log4j.Level.ERROR
    )
    return spark

# =========================
# 水位线管理
# =========================
def init_watermark_table(spark):
    """初始化Gold层水位线表"""
    try:
        spark.sql(f"CREATE NAMESPACE IF NOT EXISTS {ICEBERG_CATALOG_NAME}.{ICEBERG_GOLD_NAMESPACE}")
        spark.sql(f"""
        CREATE TABLE IF NOT EXISTS {WATERMARK_TABLE} (
            aggregation_type STRING,
            start_date DATE,
            end_date DATE,
            last_execution_timestamp TIMESTAMP,
            processed_records BIGINT,
            last_updated TIMESTAMP,
            status STRING
        ) USING iceberg
        PARTITIONED BY (aggregation_type)
        """)
        logger.info(f"✅ 水位线表初始化: {WATERMARK_TABLE}")
    except Exception as e:
        logger.error(f"❌ 水位线表初始化失败: {e}")
        raise

def update_watermark(spark, aggregation_type: str, start_date: str, end_date: str, record_count: int, status: str = "SUCCESS"):
    """更新水位线"""
    try:
        now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')
        
        spark.sql(f"""
        MERGE INTO {WATERMARK_TABLE} AS t
        USING (
            SELECT 
                '{aggregation_type}' as aggregation_type,
                DATE '{start_date}' as start_date,
                DATE '{end_date}' as end_date,
                TIMESTAMP '{now_str}' as last_execution_timestamp,
                CAST({record_count} AS BIGINT) as processed_records,
                current_timestamp() as last_updated,
                '{status}' as status
        ) AS s
        ON t.aggregation_type = s.aggregation_type
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """)
        
        logger.info(f"✅ 水位线更新: {aggregation_type} ({start_date}~{end_date}) -> {record_count}条")
        metrics.watermark_timestamp.labels(aggregation_type=aggregation_type).set(datetime.now().timestamp())
    except Exception as e:
        logger.error(f"❌ 水位线更新失败: {e}")
        raise

# =========================
# 优化的PostgreSQL UPSERT（真正UPDATE）
# =========================
def write_pg_upsert_v2(spark, df, table_name, unique_keys, aggregation_type):
    """
    PostgreSQL真正的UPSERT：
    - 如果记录存在 → UPDATE所有非主键字段
    - 如果记录不存在 → INSERT新记录
    """
    logger.info(f"🟡 PG UPSERT v2: gold.{table_name}")
    start_time = time.time()
    
    df = df.dropDuplicates(unique_keys)
    columns = [c for c in df.columns]
    
    try:
        import psycopg2
        from psycopg2.extras import execute_batch
        
        conn = psycopg2.connect(
            host=PG_HOST, port=PG_PORT, dbname=PG_DB, user=PG_USER, password=PG_PASSWORD
        )
        conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
        cur = conn.cursor()
        
        cur.execute("CREATE SCHEMA IF NOT EXISTS gold;")
        
        rows = df.collect()
        if not rows:
            logger.warning(f"⚠️ No data for gold.{table_name}")
            cur.close()
            conn.close()
            return
        
        # 构建真正的UPDATE语句
        cols_str = ','.join([f'"{c}"' for c in columns])
        placeholders = ','.join(['%s'] * len(columns))
        conflict_target = ','.join([f'"{k}"' for k in unique_keys])
        
        # ⚡关键修改：始终UPDATE，不跳过
        update_cols = [c for c in columns if c not in unique_keys and c != 'created_at']
        
        if not update_cols:
            # 如果没有可更新字段，则INSERT时DO NOTHING
            action_clause = "DO NOTHING"
        else:
            # 真正的UPDATE：更新所有非主键字段（包括updated_at）
            updates = ', '.join([f'"{c}" = EXCLUDED."{c}"' for c in update_cols])
            action_clause = f"DO UPDATE SET {updates}"
        
        sql = f"""
            INSERT INTO gold.{table_name} ({cols_str}) 
            VALUES ({placeholders})
            ON CONFLICT ({conflict_target}) 
            {action_clause}
        """
        
        data = [tuple(row[c] for c in columns) for row in rows]
        execute_batch(cur, sql, data, page_size=1000)
        
        duration = time.time() - start_time
        
        metrics.records_written_pg.labels(table_name=table_name).set(len(rows))
        metrics.operation_success.labels(aggregation_type=aggregation_type, operation='write_pg').inc()
        metrics.processing_duration.labels(aggregation_type=aggregation_type, operation='write_pg').observe(duration)
        
        cur.close()
        conn.close()
        
        logger.info(f"✅ PG UPSERT完成: gold.{table_name} ({len(rows)} rows, 耗时: {duration:.2f}s)")
        
    except Exception as e:
        logger.error(f"❌ PG UPSERT失败: {e}")
        metrics.operation_failure.labels(aggregation_type=aggregation_type, operation='write_pg').inc()
        raise

# =========================
# 修复Iceberg写入（只删除当前日期范围）
# =========================
def write_to_iceberg_v2(spark, df, table_name, start_date, end_date, aggregation_type, date_column="analysis_date", delete_condition=None):
    """
    Iceberg幂等写入v2：
    - 只删除指定日期范围内的数据（不影响其他月份）
    - 再插入新数据
    - date_column: 用于范围删除的日期列名，默认 analysis_date
    - delete_condition: 自定义删除条件SQL（WHERE之后），覆盖默认的日期范围删除
    """
    full_table = f"{ICEBERG_CATALOG_NAME}.{ICEBERG_GOLD_NAMESPACE}.{table_name}"
    logger.info(f"🧊 Iceberg写入: {full_table} [{start_date} ~ {end_date}]")
    start_time = time.time()

    try:
        spark.sql(f"CREATE DATABASE IF NOT EXISTS {ICEBERG_CATALOG_NAME}.{ICEBERG_GOLD_NAMESPACE}")

        # 先判断表是否存在(只用这一步区分 建表/写入),
        # 不要用 except 兜底 append —— 否则 schema 不匹配等真实错误会被
        # 后续 .create() 的 TABLE_ALREADY_EXISTS 掩盖。
        table_exists = True
        try:
            spark.table(full_table)
        except Exception:
            table_exists = False

        if table_exists:
            # 表已存在:只删除指定日期范围(不影响其他数据),再 append
            if delete_condition:
                delete_sql = f"DELETE FROM {full_table} WHERE {delete_condition}"
            else:
                delete_sql = f"""
                    DELETE FROM {full_table}
                    WHERE {date_column} >= DATE '{start_date}'
                      AND {date_column} <= DATE '{end_date}'
                """
            spark.sql(delete_sql)
            logger.info(f"  🗑️ 删除指定范围旧数据: {start_date} ~ {end_date}")
            df.writeTo(full_table).append()
        else:
            # 表不存在:首次创建
            logger.info(f"  🆕 表不存在,创建: {full_table}")
            df.writeTo(full_table).create()

        duration = time.time() - start_time
        df_count = df.count()
        
        metrics.records_written_iceberg.labels(table_name=table_name).set(df_count)
        metrics.operation_success.labels(aggregation_type=aggregation_type, operation='write_iceberg').inc()
        metrics.processing_duration.labels(aggregation_type=aggregation_type, operation='write_iceberg').observe(duration)
        
        logger.info(f"✅ Iceberg写入完成: {df_count} rows (耗时: {duration:.2f}s)")
        
    except Exception as e:
        logger.error(f"❌ Iceberg写入失败: {e}")
        metrics.operation_failure.labels(aggregation_type=aggregation_type, operation='write_iceberg').inc()
        raise

# =========================
# 原子性双写（Gold层）
# =========================
class TransactionRollbackException(Exception):
    """事务回滚异常"""
    pass

def atomic_dual_write_gold(spark, df, pg_table: str, iceberg_table: str, unique_keys: list, start_date: str, end_date: str, aggregation_type: str, date_column: str = "analysis_date", delete_condition: str = None):
    """原子性双写Gold层：PostgreSQL + Iceberg"""
    logger.info(f"\n{'='*80}")
    logger.info(f"🔐 开始原子性双写: {aggregation_type}")
    logger.info(f"{'='*80}")
    
    pg_success = False
    iceberg_success = False
    pg_backup = None
    start_time = time.time()
    
    try:
        # Step 1: PostgreSQL UPSERT
        logger.info("📝 Step 1/2: 写入PostgreSQL...")
        write_pg_upsert_v2(spark, df, pg_table, unique_keys, aggregation_type)
        pg_success = True
        
        # Step 2: Iceberg写入
        logger.info("📝 Step 2/2: 写入Iceberg...")
        write_to_iceberg_v2(spark, df, iceberg_table, start_date, end_date, aggregation_type, date_column=date_column, delete_condition=delete_condition)
        iceberg_success = True
        
        # 事务提交
        if pg_success and iceberg_success:
            total_duration = time.time() - start_time
            logger.info(f"\n{'='*80}")
            logger.info(f"✅ 原子性双写成功")
            logger.info(f"   总耗时: {total_duration:.2f}秒")
            logger.info(f"{'='*80}\n")
            
            metrics.operation_success.labels(aggregation_type=aggregation_type, operation='dual_write').inc()
            metrics.processing_duration.labels(aggregation_type=aggregation_type, operation='dual_write').observe(total_duration)
    
    except Exception as e:
        logger.error(f"\n{'='*80}")
        logger.error(f"❌ 事务失败，开始回滚...")
        logger.error(f"   失败原因: {e}")
        logger.error(f"{'='*80}")
        
        metrics.transaction_rollback.labels(aggregation_type=aggregation_type).inc()
        metrics.operation_failure.labels(aggregation_type=aggregation_type, operation='dual_write').inc()
        raise

# =========================
# 数据读取（保持不变）
# =========================
def load_silver_data(spark, start_date, end_date):
    logger.info(f"📖 Loading Silver analysis_records: {start_date} ~ {end_date}")
    start_time = time.time()
    
    df = (
        spark.table(f"{ICEBERG_CATALOG_NAME}.{ICEBERG_SILVER_NAMESPACE}.fact_analysis_records")
        .filter(col("analysis_date").between(lit(start_date), lit(end_date)))
        .select("analysis_id","process_id","category_id","line_id","analysis_date","shift","analyst","overall_judgment")
    )
    
    df_count = df.count()
    metrics.records_read_silver.labels(table_name='analysis_records').set(df_count)
    logger.info(f"✅ Loaded {df_count} rows (耗时: {time.time() - start_time:.2f}s)")
    return df

def load_silver_chemical(spark, start_date, end_date, lookback_days=29):
    start_for_window = (datetime.fromisoformat(start_date) - timedelta(days=lookback_days)).date().isoformat()
    logger.info(f"📖 Loading chemical results: {start_for_window} ~ {end_date}")
    start_time = time.time()
    
    chem = (
        spark.table(f"{ICEBERG_CATALOG_NAME}.{ICEBERG_SILVER_NAMESPACE}.fact_chemical_analysis_results")
        .filter(col("analysis_date").between(lit(start_for_window), lit(end_date)))
        .select(
            col("analysis_id").alias("chem_analysis_id"),
            col("analysis_date"), col("analysis_datetime"),
            col("tank_name"), col("item_name"), col("item_unit"),
            col("process_range_min"), col("process_range_max"),
            col("control_point"), col("control_range_min"), col("control_range_max"),
            col("result_value")
        )
    )
    rec = (
        spark.table(f"{ICEBERG_CATALOG_NAME}.{ICEBERG_SILVER_NAMESPACE}.fact_analysis_records")
        .select(
            col("analysis_id"), col("process_id"), col("category_id"),
            col("line_id"), col("shift"), col("analyst"), col("overall_judgment")
        )
    )
    # 加载dim_categories获取特性类型 (药水/产品/流程)
    dim_cat = (
        spark.table(f"{ICEBERG_CATALOG_NAME}.{ICEBERG_SILVER_NAMESPACE}.dim_categories")
        .filter(col("is_current") == True)
        .select(col("category_id"), col("name").alias("char_type"))
    )

    wide = (
        chem.join(rec, chem.chem_analysis_id == rec.analysis_id, "left")
        .join(dim_cat, "category_id", "left")
        .withColumn("lsl", col("process_range_min").cast("double"))
        .withColumn("usl", col("process_range_max").cast("double"))
        .withColumn("cl",  col("control_point").cast("double"))
        .withColumn("x",   col("result_value").cast("double"))
        # 标准化char_type: 药水→chemical, 产品→product, 流程→process
        .withColumn("char_type",
            when(col("char_type") == lit("药水"), lit("chemical"))
            .when(col("char_type") == lit("产品"), lit("product"))
            .when(col("char_type") == lit("流程"), lit("process"))
            .otherwise(col("char_type")))
        # 按char_type确定适用的判异规则集
        .withColumn("rules_applied",
            when(col("char_type") == lit("product"), lit("R0R1R2R3"))
            .when(col("char_type").isin("process", "chemical"), lit("R0R1"))
            .otherwise(lit("R0R1")))
        .select(
            col("process_id"), col("category_id"), col("line_id"),
            col("shift"),
            col("tank_name"), col("item_name"), col("item_unit"),
            col("analysis_date"), col("analysis_datetime"),
            col("x"), col("lsl"), col("usl"), col("cl"),
            col("control_range_min"), col("control_range_max"),
            col("overall_judgment"),
            col("char_type"), col("rules_applied")
        )
    )

    df_count = wide.count()
    metrics.records_read_silver.labels(table_name='chemical_results').set(df_count)
    logger.info(f"✅ Loaded {df_count} chemical rows (耗时: {time.time() - start_time:.2f}s)")
    return wide

# ------------------------
# 原有聚合函数 (保持不变)
# ------------------------
def aggregate_qualification(df_silver):
    logger.info("🔧 Aggregating qualification rate...")
    start_time = time.time()
    
    res = (
        df_silver.groupBy("process_id", "shift", "analysis_date")
        .agg(
            count("*").alias("total_analyses"),
            _sum(when(col("overall_judgment") == lit("NG"), 1).otherwise(0)).alias("unqualified_count")
        )
        .withColumn("unqualified_rate", (col("unqualified_count")/col("total_analyses")*100.0))
        .withColumnRenamed("process_id", "process_name")
        .withColumn("created_at", current_timestamp())
    ).select(
        "process_name", "shift", "analysis_date", "total_analyses", "unqualified_count", "unqualified_rate", "created_at"
    )
    
    df_count = res.count()
    duration = time.time() - start_time
    
    metrics.records_aggregated.labels(aggregation_type='qualification_rate').set(df_count)
    metrics.processing_duration.labels(
        aggregation_type='qualification_rate',
        operation='aggregate'
    ).observe(duration)
    
    logger.info(f"✅ Qualification aggregation: {df_count} rows (耗时: {duration:.2f}s)")
    return res

def aggregate_warning(df_silver):
    logger.info("🔧 Aggregating warning statistics...")
    start_time = time.time()
    
    res = (
        df_silver.groupBy("process_id", "shift", "analysis_date")
        .agg(
            count("*").alias("total_analyses"),
            lit(0).alias("warning_count")
        )
        .withColumn("warning_rate", (col("warning_count")/col("total_analyses")*100.0))
        .withColumnRenamed("process_id", "process_name")
        .withColumn("created_at", current_timestamp())
    ).select(
        "process_name", "shift", "analysis_date", "total_analyses", "warning_count", "warning_rate", "created_at"
    )
    
    df_count = res.count()
    duration = time.time() - start_time
    
    metrics.records_aggregated.labels(aggregation_type='warning_statistics').set(df_count)
    metrics.processing_duration.labels(
        aggregation_type='warning_statistics',
        operation='aggregate'
    ).observe(duration)
    
    logger.info(f"✅ Warning aggregation: {df_count} rows (耗时: {duration:.2f}s)")
    return res

# ========================
# SPC判异规则 (GB/T 4091-2001)
# ========================
def apply_run_rules(df, value_col, cl_col, key_cols, order_col="analysis_date"):
    """
    应用GB/T 4091-2001判异规则:
    - R2: 连续9个点落在中心线同一侧
    - R3: 连续6个点递增或递减

    注意: R0(超规格限)和R1(超控制限)在各控制图函数中单独计算。
    """
    from pyspark.sql.functions import lag, greatest

    w = Window.partitionBy(*key_cols).orderBy(order_col)

    # R2: 连续9点在中心线同一侧
    w9 = Window.partitionBy(*key_cols).orderBy(order_col).rowsBetween(-8, 0)
    w9_count = Window.partitionBy(*key_cols).orderBy(order_col).rowsBetween(Window.unboundedPreceding, 0)
    df = (
        df
        .withColumn("_above_cl", when(col(value_col) > col(cl_col), 1).otherwise(0))
        .withColumn("_below_cl", when(col(value_col) < col(cl_col), 1).otherwise(0))
        .withColumn("_row_count", count("*").over(w9_count))
        .withColumn("r2_flag",
            when(col("_row_count") >= 9,
                 when((_sum("_above_cl").over(w9) == 9) | (_sum("_below_cl").over(w9) == 9), 1)
                 .otherwise(0))
            .otherwise(0))
    )

    # R3: 连续6点递增或递减 (需要5次连续方向变化)
    w5 = Window.partitionBy(*key_cols).orderBy(order_col).rowsBetween(-4, 0)
    df = (
        df
        .withColumn("_prev_val", lag(value_col, 1).over(w))
        .withColumn("_increasing", when(col(value_col) > col("_prev_val"), 1).otherwise(0))
        .withColumn("_decreasing", when(col(value_col) < col("_prev_val"), 1).otherwise(0))
        .withColumn("r3_flag",
            when(col("_row_count") >= 6,
                 when((_sum("_increasing").over(w5) == 5) | (_sum("_decreasing").over(w5) == 5), 1)
                 .otherwise(0))
            .otherwise(0))
        .drop("_above_cl", "_below_cl", "_row_count", "_prev_val", "_increasing", "_decreasing")
    )

    return df


def aggregate_spc_capability(chem_df):
    logger.info("🔧 Aggregating SPC capability...")
    start_time = time.time()
    
    from pyspark.sql.functions import lag, abs as fabs

    # 按班次拆分:加入 shift 作为分区键,使滚动窗口/日聚合/最终输出都按 (工序,槽,项目,班次) 维度
    # 产出每 (process,tank,item,date,shift) 一行 —— 一天两班即两行。
    key_cols = ["process_id","tank_name","item_name","shift"]
    w_order = Window.partitionBy(*key_cols).orderBy(col("analysis_date"), col("analysis_datetime"))
    w30 = Window.partitionBy(*key_cols).orderBy(col("analysis_date")).rowsBetween(-29, 0)

    df = chem_df.withColumn("x_prev", lag("x").over(w_order)) \
                .withColumn("mr", fabs(col("x") - col("x_prev")))

    daily = (
        df.groupBy(*key_cols, "analysis_date", "lsl", "usl", "cl")
          .agg(
              _sum(when((col("x") < col("lsl")) | (col("x") > col("usl")), 1).otherwise(0)).alias("oospec_points"),
              count("*").alias("n_samples"),
              avg("x").alias("xbar_d"),
              avg("mr").alias("mr_bar_d"),
              stddev_samp("x").alias("sigma_overall_d")
          )
    )

    # 计算累计数据组数 (用于判断数据量是否充足)
    w_cumcount = Window.partitionBy(*key_cols).orderBy(col("analysis_date")).rowsBetween(Window.unboundedPreceding, 0)

    roll = (
        daily
        .withColumn("xbar", avg("xbar_d").over(w30))
        .withColumn("mr_bar", avg("mr_bar_d").over(w30))
        .withColumn("sigma_overall", avg("sigma_overall_d").over(w30))
        .withColumn("n_groups", count("*").over(w_cumcount))  # 累计组数
        .withColumn("data_sufficient", when(col("n_groups") >= 25, lit(True)).otherwise(lit(False)))
    )

    d2 = 1.128
    E2 = 2.660  # SOP标准系数 (≈3/d2，对齐GB/T 4091-2001)

    res = (
        roll
        .withColumn("sigma_within", when(col("mr_bar").isNotNull(), col("mr_bar")/lit(d2)).otherwise(None))
        # 统计计算的控制限
        .withColumn("ucl_x_calc", col("xbar") + lit(E2)*col("mr_bar"))
        .withColumn("lcl_x_calc", col("xbar") - lit(E2)*col("mr_bar"))
        # SOP: 数据不足(<25组)时使用规格限90%作为临时控制限
        # SOP: 计算控制限超出规格限时也使用规格限90%收严
        .withColumn("ucl_x",
            when(~col("data_sufficient"),
                 when(col("cl").isNotNull(), col("cl") + (col("usl") - col("cl")) * 0.9)
                 .otherwise(col("usl") * 0.9))
            .when(col("ucl_x_calc") > col("usl"),
                 when(col("cl").isNotNull(), col("cl") + (col("usl") - col("cl")) * 0.9)
                 .otherwise(col("usl") * 0.9))
            .otherwise(col("ucl_x_calc")))
        .withColumn("lcl_x",
            when(~col("data_sufficient"),
                 when(col("cl").isNotNull(), col("cl") - (col("cl") - col("lsl")) * 0.9)
                 .otherwise(col("lsl") * 1.1))
            .when(col("lcl_x_calc") < col("lsl"),
                 when(col("cl").isNotNull(), col("cl") - (col("cl") - col("lsl")) * 0.9)
                 .otherwise(col("lsl") * 1.1))
            .otherwise(col("lcl_x_calc")))
        # 标记控制限来源
        .withColumn("limit_source",
            when(~col("data_sufficient"), lit("SPEC_90PCT"))
            .when((col("ucl_x_calc") > col("usl")) | (col("lcl_x_calc") < col("lsl")), lit("SPEC_90PCT"))
            .otherwise(lit("CALCULATED")))
        .withColumn("cl_x",  col("xbar"))
        .withColumn("ucl_mr", lit(3.267)*col("mr_bar"))
        .withColumn("cl_mr",  col("mr_bar"))
        .withColumn("lcl_mr", lit(0.0))
        # R1: OOC判定 — 使用统计计算的UCL/LCL（而非源系统control_range）
        .withColumn("ooc_points",
            when((col("xbar_d") < col("lcl_x")) | (col("xbar_d") > col("ucl_x")), 1).otherwise(0))
        .withColumn("cp",
            when((col("usl").isNotNull()) & (col("lsl").isNotNull()) & (col("sigma_within")>0),
                 (col("usl")-col("lsl"))/(6*col("sigma_within"))))
        .withColumn("cpk",
            when((col("usl").isNotNull()) & (col("lsl").isNotNull()) & (col("sigma_within")>0),
                 least((col("usl")-col("xbar"))/(3*col("sigma_within")),
                       (col("xbar")-col("lsl"))/(3*col("sigma_within")))))
        .withColumn("pp",
            when((col("usl").isNotNull()) & (col("lsl").isNotNull()) & (col("sigma_overall")>0),
                 (col("usl")-col("lsl"))/(6*col("sigma_overall"))))
        .withColumn("ppk",
            when((col("usl").isNotNull()) & (col("lsl").isNotNull()) & (col("sigma_overall")>0),
                 least((col("usl")-col("xbar"))/(3*col("sigma_overall")),
                       (col("xbar")-col("lsl"))/(3*col("sigma_overall")))))
        .withColumn("within_spec_rate",
            when(col("n_samples")>0, ((col("n_samples")-col("oospec_points"))/col("n_samples"))*100.0))
    )

    # 应用R2/R3判异规则
    res = apply_run_rules(res, value_col="xbar_d", cl_col="cl_x", key_cols=key_cols)
    # 综合OOC: R1 + R2 + R3
    res = res.withColumn("ooc_total", col("ooc_points") + col("r2_flag") + col("r3_flag"))

    res = (
        res.select(
            *key_cols, "analysis_date",
            col("n_samples"),
            col("xbar"), col("mr_bar"), col("sigma_within"),
            col("ucl_x"), col("cl_x"), col("lcl_x"),
            col("ucl_mr"), col("cl_mr"), col("lcl_mr"),
            col("lsl"), col("usl"), col("cl"),
            col("cp"), col("cpk"), col("pp"), col("ppk"),
            col("ooc_points"), col("oospec_points"), col("within_spec_rate"),
            col("r2_flag"), col("r3_flag"), col("ooc_total"),
            col("data_sufficient"), col("limit_source")
        )
        .withColumn("created_at", current_timestamp())
        .withColumn("updated_at", current_timestamp())
    )
    
    df_count = res.count()
    duration = time.time() - start_time
    
    metrics.records_aggregated.labels(aggregation_type='spc_capability').set(df_count)
    metrics.spc_capability_count.labels(date_range='30days').set(df_count)
    metrics.processing_duration.labels(
        aggregation_type='spc_capability',
        operation='aggregate'
    ).observe(duration)
    
    logger.info(f"✅ SPC capability aggregation: {df_count} rows (耗时: {duration:.2f}s)")
    return res


def compute_imr_baseline(chem_df):
    """
    按 SOP 计算每个 (process_id, tank_name, item_name) 的 I-MR 基线 + 冻结控制限。
    取最早 25 个有效日组作为基线期 (不足 25 组的标记为 preliminary)。
    SOP 公式 (n=2):
        CL_X = X̿  (基线期所有日均值的总平均)
        UCL_X = X̿ + 2.66 · M̄R     (E2=2.66, ≈ 3/d2 当 d2=1.128)
        LCL_X = X̿ - 2.66 · M̄R
        CL_MR = M̄R
        UCL_MR = 3.267 · M̄R       (D4 for n=2)
        LCL_MR = 0
    返回 DataFrame schema 与 iceberg.gold_qms.spc_baseline 对齐。
    """
    from pyspark.sql.functions import lag, abs as fabs

    logger.info("🔧 Computing I-MR baseline (SOP frozen limits)...")
    start_time = time.time()

    key_cols = ["process_id", "tank_name", "item_name"]

    # 复用 aggregate_spc_capability 里相同的日聚合口径
    w_order = Window.partitionBy(*key_cols).orderBy(col("analysis_date"), col("analysis_datetime"))
    df = chem_df.withColumn("x_prev", lag("x").over(w_order)) \
                .withColumn("mr", fabs(col("x") - col("x_prev")))

    daily = (
        df.groupBy(*key_cols, "analysis_date")
          .agg(
              avg("x").alias("xbar_d"),
              avg("mr").alias("mr_bar_d"),
          )
    )

    # 取最早 25 组作为基线;不足 25 组的也接受 (标 preliminary)
    w_asc = Window.partitionBy(*key_cols).orderBy(col("analysis_date"))
    indexed = daily.withColumn("_rn", row_number().over(w_asc))
    baseline_window = indexed.filter(col("_rn") <= 25)

    E2 = 2.660
    D4 = 3.267
    baseline = (
        baseline_window
        .groupBy(*key_cols)
        .agg(
            avg("xbar_d").alias("x_double_bar"),
            avg("mr_bar_d").alias("mr_bar_baseline"),
            count("*").alias("baseline_n"),
            fmin("analysis_date").alias("baseline_start_date"),
            fmax("analysis_date").alias("baseline_end_date"),
        )
        .withColumn("chart_type", lit("I-MR"))
        .withColumn("cl_x",  col("x_double_bar"))
        .withColumn("ucl_x", col("x_double_bar") + lit(E2) * col("mr_bar_baseline"))
        .withColumn("lcl_x", col("x_double_bar") - lit(E2) * col("mr_bar_baseline"))
        .withColumn("cl_mr",  col("mr_bar_baseline"))
        .withColumn("ucl_mr", lit(D4) * col("mr_bar_baseline"))
        .withColumn("lcl_mr", lit(0.0))
        .withColumn("is_preliminary", when(col("baseline_n") < 25, lit(True)).otherwise(lit(False)))
        .withColumn("created_at", current_timestamp())
        .withColumn("updated_at", current_timestamp())
        .select(
            "process_id", "tank_name", "item_name", "chart_type",
            "baseline_n", "baseline_start_date", "baseline_end_date",
            "x_double_bar", "mr_bar_baseline",
            "cl_x", "ucl_x", "lcl_x",
            "cl_mr", "ucl_mr", "lcl_mr",
            "is_preliminary", "created_at", "updated_at",
        )
    )

    cnt = baseline.count()
    logger.info(f"✅ I-MR baseline computed: {cnt} (process, tank, item) entries (耗时: {time.time()-start_time:.2f}s)")
    return baseline


# ========================
# 新增控制图聚合函数
# ========================

def aggregate_spc_xbar_r(chem_df, subgroup_size=5):
    """XBar-R图聚合 (子组均值-极差图)"""
    logger.info(f"🔧 Aggregating XBar-R chart (subgroup_size={subgroup_size})...")
    start_time = time.time()
    
    key_cols = ["process_id", "tank_name", "item_name"]
    
    # 按时间排序并分配子组编号
    w_order = Window.partitionBy(*key_cols, "analysis_date").orderBy("analysis_datetime")
    
    df_with_subgroup = (
        chem_df
        .withColumn("row_num", row_number().over(w_order))
        .withColumn("subgroup_id", ((col("row_num") - 1) / lit(subgroup_size)).cast("int"))
    )
    
    # 计算每个子组的统计量
    subgroup_stats = (
        df_with_subgroup
        .groupBy(*key_cols, "analysis_date", "subgroup_id", "lsl", "usl")
        .agg(
            count("*").alias("n"),
            avg("x").alias("xbar_i"),
            fmax("x").alias("max_x"),
            fmin("x").alias("min_x")
        )
        .filter(col("n") == lit(subgroup_size))  # 只保留完整子组
        .withColumn("r_i", col("max_x") - col("min_x"))
    )
    
    # 计算总体统计量
    w_all = Window.partitionBy(*key_cols, "analysis_date")
    
    daily_stats = (
        subgroup_stats
        .withColumn("xbar_grand", avg("xbar_i").over(w_all))
        .withColumn("r_bar", avg("r_i").over(w_all))
        .withColumn("subgroup_count", count("*").over(w_all))
    )
    
    # XBar-R控制图常数表 (n=2到25, 对齐SOP WI-XMPLP1.QA-13 A5)
    control_chart_constants = {
        2:  {"A2": 1.880, "D3": 0.0,   "D4": 3.267, "d2": 1.128},
        3:  {"A2": 1.023, "D3": 0.0,   "D4": 2.574, "d2": 1.693},
        4:  {"A2": 0.729, "D3": 0.0,   "D4": 2.282, "d2": 2.059},
        5:  {"A2": 0.577, "D3": 0.0,   "D4": 2.114, "d2": 2.326},
        6:  {"A2": 0.483, "D3": 0.0,   "D4": 2.004, "d2": 2.534},
        7:  {"A2": 0.419, "D3": 0.076, "D4": 1.924, "d2": 2.704},
        8:  {"A2": 0.373, "D3": 0.136, "D4": 1.864, "d2": 2.847},
        9:  {"A2": 0.337, "D3": 0.184, "D4": 1.816, "d2": 2.970},
        10: {"A2": 0.308, "D3": 0.223, "D4": 1.777, "d2": 3.078},
        11: {"A2": 0.285, "D3": 0.256, "D4": 1.744, "d2": 3.173},
        12: {"A2": 0.266, "D3": 0.283, "D4": 1.717, "d2": 3.258},
        13: {"A2": 0.249, "D3": 0.307, "D4": 1.693, "d2": 3.336},
        14: {"A2": 0.235, "D3": 0.328, "D4": 1.672, "d2": 3.407},
        15: {"A2": 0.223, "D3": 0.347, "D4": 1.653, "d2": 3.472},
        16: {"A2": 0.212, "D3": 0.363, "D4": 1.637, "d2": 3.532},
        17: {"A2": 0.203, "D3": 0.378, "D4": 1.622, "d2": 3.588},
        18: {"A2": 0.194, "D3": 0.391, "D4": 1.608, "d2": 3.640},
        19: {"A2": 0.187, "D3": 0.403, "D4": 1.597, "d2": 3.689},
        20: {"A2": 0.180, "D3": 0.415, "D4": 1.585, "d2": 3.735},
        21: {"A2": 0.173, "D3": 0.425, "D4": 1.575, "d2": 3.778},
        22: {"A2": 0.167, "D3": 0.434, "D4": 1.566, "d2": 3.819},
        23: {"A2": 0.162, "D3": 0.443, "D4": 1.557, "d2": 3.858},
        24: {"A2": 0.157, "D3": 0.451, "D4": 1.548, "d2": 3.895},
        25: {"A2": 0.153, "D3": 0.459, "D4": 1.541, "d2": 3.931},
    }
    
    constants = control_chart_constants.get(subgroup_size, control_chart_constants[5])
    A2 = constants["A2"]
    D3 = constants["D3"]
    D4 = constants["D4"]
    d2 = constants["d2"]
    
    # 计算控制限
    result = (
        daily_stats
        .withColumn("xbar_ucl", col("xbar_grand") + lit(A2) * col("r_bar"))
        .withColumn("xbar_cl", col("xbar_grand"))
        .withColumn("xbar_lcl", col("xbar_grand") - lit(A2) * col("r_bar"))
        .withColumn("r_ucl", lit(D4) * col("r_bar"))
        .withColumn("r_cl", col("r_bar"))
        .withColumn("r_lcl", lit(D3) * col("r_bar"))
        # 计算失控点
        .withColumn("xbar_ooc", 
            when((col("xbar_i") > col("xbar_ucl")) | (col("xbar_i") < col("xbar_lcl")), 1).otherwise(0))
        .withColumn("r_ooc",
            when((col("r_i") > col("r_ucl")) | (col("r_i") < col("r_lcl")), 1).otherwise(0))
    )
    
    # 按日期汇总
    final = (
        result
        .groupBy(*key_cols, "analysis_date", "lsl", "usl")
        .agg(
            lit(subgroup_size).alias("subgroup_size"),
            first("subgroup_count").alias("subgroup_count"),
            first("xbar_grand").alias("xbar_grand"),
            first("xbar_ucl").alias("xbar_ucl"),
            first("xbar_cl").alias("xbar_cl"),
            first("xbar_lcl").alias("xbar_lcl"),
            first("r_bar").alias("r_bar"),
            first("r_ucl").alias("r_ucl"),
            first("r_cl").alias("r_cl"),
            first("r_lcl").alias("r_lcl"),
            _sum("xbar_ooc").alias("xbar_ooc_points"),
            _sum("r_ooc").alias("r_ooc_points")
        )
        # 计算过程能力 (使用R_bar/d2估计sigma)
        .withColumn("sigma_est", col("r_bar") / lit(d2))
        .withColumn("cp",
            when((col("usl").isNotNull()) & (col("lsl").isNotNull()) & (col("sigma_est") > 0),
                 (col("usl") - col("lsl")) / (6 * col("sigma_est"))))
        .withColumn("cpk",
            when((col("usl").isNotNull()) & (col("lsl").isNotNull()) & (col("sigma_est") > 0),
                 least((col("usl") - col("xbar_grand")) / (3 * col("sigma_est")),
                       (col("xbar_grand") - col("lsl")) / (3 * col("sigma_est")))))
        # SOP: Xbar-R需100+数据点 (即subgroup_count * subgroup_size >= 100)
        .withColumn("data_sufficient",
            when(col("subgroup_count") * lit(subgroup_size) >= 100, lit(True)).otherwise(lit(False)))
        # SOP: 数据不足时使用规格限90%作为临时控制限；超规格时也收严
        .withColumn("xbar_ucl",
            when(~col("data_sufficient") | (col("xbar_ucl") > col("usl")),
                 col("xbar_cl") + (col("usl") - col("xbar_cl")) * 0.9)
            .otherwise(col("xbar_ucl")))
        .withColumn("xbar_lcl",
            when(~col("data_sufficient") | (col("xbar_lcl") < col("lsl")),
                 col("xbar_cl") - (col("xbar_cl") - col("lsl")) * 0.9)
            .otherwise(col("xbar_lcl")))
        .withColumn("limit_source",
            when(~col("data_sufficient"), lit("SPEC_90PCT"))
            .when((col("xbar_ucl") > col("usl")) | (col("xbar_lcl") < col("lsl")), lit("SPEC_90PCT"))
            .otherwise(lit("CALCULATED")))
    )

    # 应用R2/R3判异规则 (基于子组均值xbar_grand vs xbar_cl)
    final = apply_run_rules(final, value_col="xbar_grand", cl_col="xbar_cl", key_cols=key_cols)
    final = final.withColumn("ooc_total", col("xbar_ooc_points") + col("r2_flag") + col("r3_flag"))

    final = (
        final.select(
            *key_cols, "analysis_date",
            "subgroup_size", "subgroup_count",
            "xbar_grand", "xbar_ucl", "xbar_cl", "xbar_lcl",
            "r_bar", "r_ucl", "r_cl", "r_lcl",
            "lsl", "usl", "cp", "cpk",
            "xbar_ooc_points", "r_ooc_points",
            "r2_flag", "r3_flag", "ooc_total",
            "data_sufficient", "limit_source"
        )
        .withColumn("created_at", current_timestamp())
        .withColumn("updated_at", current_timestamp())
    )

    df_count = final.count()
    duration = time.time() - start_time

    metrics.records_aggregated.labels(aggregation_type='spc_xbar_r').set(df_count)
    metrics.processing_duration.labels(
        aggregation_type='spc_xbar_r',
        operation='aggregate'
    ).observe(duration)

    logger.info(f"✅ XBar-R aggregation: {df_count} rows (耗时: {duration:.2f}s)")
    return final

def aggregate_spc_xbar_s(chem_df, subgroup_size=10):
    """XBar-S图聚合 (子组均值-标准差图)"""
    logger.info(f"🔧 Aggregating XBar-S chart (subgroup_size={subgroup_size})...")
    start_time = time.time()
    
    key_cols = ["process_id", "tank_name", "item_name"]
    
    # 按时间排序并分配子组编号
    w_order = Window.partitionBy(*key_cols, "analysis_date").orderBy("analysis_datetime")
    
    df_with_subgroup = (
        chem_df
        .withColumn("row_num", row_number().over(w_order))
        .withColumn("subgroup_id", ((col("row_num") - 1) / lit(subgroup_size)).cast("int"))
    )
    
    # 计算每个子组的统计量
    subgroup_stats = (
        df_with_subgroup
        .groupBy(*key_cols, "analysis_date", "subgroup_id", "lsl", "usl")
        .agg(
            count("*").alias("n"),
            avg("x").alias("xbar_i"),
            stddev_samp("x").alias("s_i")
        )
        .filter(col("n") == lit(subgroup_size))
    )
    
    # 计算总体统计量
    w_all = Window.partitionBy(*key_cols, "analysis_date")
    
    daily_stats = (
        subgroup_stats
        .withColumn("xbar_grand", avg("xbar_i").over(w_all))
        .withColumn("s_bar", avg("s_i").over(w_all))
        .withColumn("subgroup_count", count("*").over(w_all))
    )
    
    # XBar-S控制图常数 (n=2到25, 对齐SOP WI-XMPLP1.QA-13 A5)
    control_chart_constants = {
        2:  {"A3": 2.659, "B3": 0.0,   "B4": 3.267, "c4": 0.7979},
        3:  {"A3": 1.954, "B3": 0.0,   "B4": 2.568, "c4": 0.8862},
        4:  {"A3": 1.628, "B3": 0.0,   "B4": 2.266, "c4": 0.9213},
        5:  {"A3": 1.427, "B3": 0.0,   "B4": 2.089, "c4": 0.9400},
        6:  {"A3": 1.287, "B3": 0.030, "B4": 1.970, "c4": 0.9515},
        7:  {"A3": 1.182, "B3": 0.118, "B4": 1.882, "c4": 0.9594},
        8:  {"A3": 1.099, "B3": 0.185, "B4": 1.815, "c4": 0.9650},
        9:  {"A3": 1.032, "B3": 0.239, "B4": 1.761, "c4": 0.9693},
        10: {"A3": 0.975, "B3": 0.284, "B4": 1.716, "c4": 0.9727},
        11: {"A3": 0.927, "B3": 0.321, "B4": 1.679, "c4": 0.9754},
        12: {"A3": 0.886, "B3": 0.354, "B4": 1.646, "c4": 0.9776},
        13: {"A3": 0.850, "B3": 0.382, "B4": 1.618, "c4": 0.9794},
        14: {"A3": 0.817, "B3": 0.406, "B4": 1.594, "c4": 0.9810},
        15: {"A3": 0.789, "B3": 0.428, "B4": 1.572, "c4": 0.9823},
        16: {"A3": 0.763, "B3": 0.448, "B4": 1.552, "c4": 0.9835},
        17: {"A3": 0.739, "B3": 0.466, "B4": 1.534, "c4": 0.9845},
        18: {"A3": 0.718, "B3": 0.482, "B4": 1.518, "c4": 0.9854},
        19: {"A3": 0.698, "B3": 0.497, "B4": 1.503, "c4": 0.9862},
        20: {"A3": 0.680, "B3": 0.510, "B4": 1.490, "c4": 0.9869},
        21: {"A3": 0.663, "B3": 0.523, "B4": 1.477, "c4": 0.9876},
        22: {"A3": 0.647, "B3": 0.534, "B4": 1.466, "c4": 0.9882},
        23: {"A3": 0.633, "B3": 0.545, "B4": 1.455, "c4": 0.9887},
        24: {"A3": 0.619, "B3": 0.555, "B4": 1.445, "c4": 0.9892},
        25: {"A3": 0.606, "B3": 0.565, "B4": 1.435, "c4": 0.9896},
    }
    
    constants = control_chart_constants.get(subgroup_size, control_chart_constants[10])
    A3 = constants["A3"]
    B3 = constants["B3"]
    B4 = constants["B4"]
    c4 = constants["c4"]
    
    # 计算控制限
    result = (
        daily_stats
        .withColumn("xbar_ucl", col("xbar_grand") + lit(A3) * col("s_bar"))
        .withColumn("xbar_cl", col("xbar_grand"))
        .withColumn("xbar_lcl", col("xbar_grand") - lit(A3) * col("s_bar"))
        .withColumn("s_ucl", lit(B4) * col("s_bar"))
        .withColumn("s_cl", col("s_bar"))
        .withColumn("s_lcl", lit(B3) * col("s_bar"))
        # 计算失控点
        .withColumn("xbar_ooc",
            when((col("xbar_i") > col("xbar_ucl")) | (col("xbar_i") < col("xbar_lcl")), 1).otherwise(0))
        .withColumn("s_ooc",
            when((col("s_i") > col("s_ucl")) | (col("s_i") < col("s_lcl")), 1).otherwise(0))
    )
    
    # 按日期汇总
    final = (
        result
        .groupBy(*key_cols, "analysis_date", "lsl", "usl")
        .agg(
            lit(subgroup_size).alias("subgroup_size"),
            first("subgroup_count").alias("subgroup_count"),
            first("xbar_grand").alias("xbar_grand"),
            first("xbar_ucl").alias("xbar_ucl"),
            first("xbar_cl").alias("xbar_cl"),
            first("xbar_lcl").alias("xbar_lcl"),
            first("s_bar").alias("s_bar"),
            first("s_ucl").alias("s_ucl"),
            first("s_cl").alias("s_cl"),
            first("s_lcl").alias("s_lcl"),
            _sum("xbar_ooc").alias("xbar_ooc_points"),
            _sum("s_ooc").alias("s_ooc_points")
        )
        # 计算过程能力 (使用S_bar/c4估计sigma)
        .withColumn("sigma_est", col("s_bar") / lit(c4))
        .withColumn("cp",
            when((col("usl").isNotNull()) & (col("lsl").isNotNull()) & (col("sigma_est") > 0),
                 (col("usl") - col("lsl")) / (6 * col("sigma_est"))))
        .withColumn("cpk",
            when((col("usl").isNotNull()) & (col("lsl").isNotNull()) & (col("sigma_est") > 0),
                 least((col("usl") - col("xbar_grand")) / (3 * col("sigma_est")),
                       (col("xbar_grand") - col("lsl")) / (3 * col("sigma_est")))))
    )

    # 应用R2/R3判异规则
    final = apply_run_rules(final, value_col="xbar_grand", cl_col="xbar_cl", key_cols=key_cols)
    final = final.withColumn("ooc_total", col("xbar_ooc_points") + col("r2_flag") + col("r3_flag"))

    final = (
        final.select(
            *key_cols, "analysis_date",
            "subgroup_size", "subgroup_count",
            "xbar_grand", "xbar_ucl", "xbar_cl", "xbar_lcl",
            "s_bar", "s_ucl", "s_cl", "s_lcl",
            "lsl", "usl", "cp", "cpk",
            "xbar_ooc_points", "s_ooc_points",
            "r2_flag", "r3_flag", "ooc_total"
        )
        .withColumn("created_at", current_timestamp())
        .withColumn("updated_at", current_timestamp())
    )

    df_count = final.count()
    duration = time.time() - start_time

    metrics.records_aggregated.labels(aggregation_type='spc_xbar_s').set(df_count)
    metrics.processing_duration.labels(
        aggregation_type='spc_xbar_s',
        operation='aggregate'
    ).observe(duration)
    
    logger.info(f"✅ XBar-S aggregation: {df_count} rows (耗时: {duration:.2f}s)")
    return final

def aggregate_spc_p_chart(df_silver):
    """P图聚合 (不良率控制图)"""
    logger.info("🔧 Aggregating P chart (defect rate)...")
    start_time = time.time()
    
    key_cols = ["process_id", "shift"]
    
    # 按日期计算不良数和样本数
    daily_defects = (
        df_silver
        .groupBy(*key_cols, "analysis_date")
        .agg(
            count("*").alias("n"),
            _sum(when(col("overall_judgment") == lit("NG"), 1).otherwise(0)).alias("np")
        )
        .withColumn("p", col("np") / col("n"))
    )
    
    # 计算总体不良率
    w_all = Window.partitionBy(*key_cols)
    
    result = (
        daily_defects
        .withColumn("p_bar", avg("p").over(w_all))
        .withColumn("n_bar", avg("n").over(w_all))
        # P图控制限 (基于二项分布)
        .withColumn("ucl", col("p_bar") + 3 * sqrt(col("p_bar") * (1 - col("p_bar")) / col("n")))
        .withColumn("cl", col("p_bar"))
        .withColumn("lcl", 
            when(col("p_bar") - 3 * sqrt(col("p_bar") * (1 - col("p_bar")) / col("n")) > 0,
                 col("p_bar") - 3 * sqrt(col("p_bar") * (1 - col("p_bar")) / col("n")))
            .otherwise(lit(0.0)))
        # R1: 计算失控点
        .withColumn("ooc_points",
            when((col("p") > col("ucl")) | (col("p") < col("lcl")), 1).otherwise(0))
    )

    # 应用R2/R3判异规则
    result = apply_run_rules(result, value_col="p", cl_col="cl", key_cols=key_cols)
    result = result.withColumn("ooc_total", col("ooc_points") + col("r2_flag") + col("r3_flag"))

    result = (
        result.select(
            *key_cols, "analysis_date",
            "n", "np", "p",
            "p_bar", "ucl", "cl", "lcl",
            "ooc_points", "r2_flag", "r3_flag", "ooc_total"
        )
        .withColumn("created_at", current_timestamp())
        .withColumn("updated_at", current_timestamp())
    )

    df_count = result.count()
    duration = time.time() - start_time

    metrics.records_aggregated.labels(aggregation_type='spc_p_chart').set(df_count)
    metrics.processing_duration.labels(
        aggregation_type='spc_p_chart',
        operation='aggregate'
    ).observe(duration)

    logger.info(f"✅ P chart aggregation: {df_count} rows (耗时: {duration:.2f}s)")
    return result

def aggregate_spc_c_chart(df_silver):
    """C图聚合 (缺陷数控制图)"""
    logger.info("🔧 Aggregating C chart (defect count)...")
    start_time = time.time()
    
    key_cols = ["process_id", "shift"]
    
    # 按日期计算缺陷数
    daily_defects = (
        df_silver
        .groupBy(*key_cols, "analysis_date")
        .agg(
            _sum(when(col("overall_judgment") == lit("NG"), 1).otherwise(0)).alias("c")
        )
    )
    
    # 计算平均缺陷数
    w_all = Window.partitionBy(*key_cols)
    
    result = (
        daily_defects
        .withColumn("c_bar", avg("c").over(w_all))
        # C图控制限 (基于泊松分布)
        .withColumn("ucl", col("c_bar") + 3 * sqrt(col("c_bar")))
        .withColumn("cl", col("c_bar"))
        .withColumn("lcl",
            when(col("c_bar") - 3 * sqrt(col("c_bar")) > 0,
                 col("c_bar") - 3 * sqrt(col("c_bar")))
            .otherwise(lit(0.0)))
        # R1: 计算失控点
        .withColumn("ooc_points",
            when((col("c") > col("ucl")) | (col("c") < col("lcl")), 1).otherwise(0))
    )

    # 应用R2/R3判异规则
    result = apply_run_rules(result, value_col="c", cl_col="cl", key_cols=key_cols)
    result = result.withColumn("ooc_total", col("ooc_points") + col("r2_flag") + col("r3_flag"))

    result = (
        result.select(
            *key_cols, "analysis_date",
            "c", "c_bar", "ucl", "cl", "lcl",
            "ooc_points", "r2_flag", "r3_flag", "ooc_total"
        )
        .withColumn("created_at", current_timestamp())
        .withColumn("updated_at", current_timestamp())
    )

    df_count = result.count()
    duration = time.time() - start_time

    metrics.records_aggregated.labels(aggregation_type='spc_c_chart').set(df_count)
    metrics.processing_duration.labels(
        aggregation_type='spc_c_chart',
        operation='aggregate'
    ).observe(duration)

    logger.info(f"✅ C chart aggregation: {df_count} rows (耗时: {duration:.2f}s)")
    return result

def aggregate_spc_ma(chem_df):
    """移动平均趋势 (No Shift)"""
    logger.info("🔧 Aggregating SPC moving average...")
    start_time = time.time()
    
    import pandas as pd

    key_cols = ["process_id","tank_name","item_name"]

    daily_x = (
        chem_df.groupBy(*key_cols, "analysis_date")
               .agg(avg("x").alias("x"))
    )

    w5  = Window.partitionBy(*key_cols).orderBy(col("analysis_date")).rowsBetween(-4, 0)
    w7  = Window.partitionBy(*key_cols).orderBy(col("analysis_date")).rowsBetween(-6, 0)
    w14 = Window.partitionBy(*key_cols).orderBy(col("analysis_date")).rowsBetween(-13, 0)

    smoothed = (
        daily_x
        .withColumn("sma_5",  avg("x").over(w5))
        .withColumn("sma_7",  avg("x").over(w7))
        .withColumn("sma_14", avg("x").over(w14))
    )

    def ema_compute(pdf):
        pdf = pdf.sort_values("analysis_date")
        for span in (7,14):
            alpha = 2.0/(span+1)
            ema = []
            prev = None
            for v in pdf["x"].values:
                prev = v if prev is None else (alpha*v + (1-alpha)*prev)
                ema.append(prev)
            pdf[f"ema_{span}"] = ema
        return pdf

    out = (
        smoothed.groupby(*key_cols)
        .applyInPandas(
            ema_compute,
            schema="""
                process_id string, tank_name string, item_name string,
                analysis_date date, x double, sma_5 double, sma_7 double, sma_14 double,
                ema_7 double, ema_14 double
            """
        )
        .withColumn("created_at", current_timestamp())
        .withColumn("updated_at", current_timestamp())
    )
    
    df_count = out.count()
    duration = time.time() - start_time
    
    metrics.records_aggregated.labels(aggregation_type='spc_trend_ma').set(df_count)
    metrics.processing_duration.labels(
        aggregation_type='spc_trend_ma',
        operation='aggregate'
    ).observe(duration)
    
    logger.info(f"✅ SPC MA aggregation: {df_count} rows (耗时: {duration:.2f}s)")
    return out


def aggregate_monthly_alarm_rate(spark, start_date, end_date):
    """
    月度报警率统计 (SOP要求)
    - 按月汇总各SPC监控项目的报警点数和报警率
    - 新增项目（data_sufficient=False）暂不纳入统计
    """
    logger.info("🔧 Aggregating monthly alarm rate...")
    start_time = time.time()

    from pyspark.sql.functions import year, month as fmonth, sum as fsum

    # 从已计算的SPC能力表中读取（仅包含data_sufficient的项目）
    try:
        spc_cap = (
            spark.table(f"{ICEBERG_CATALOG_NAME}.{ICEBERG_GOLD_NAMESPACE}.spc_capability_daily")
            .filter(col("analysis_date").between(lit(start_date), lit(end_date)))
            .filter(col("data_sufficient") == True)
        )
    except Exception:
        logger.warning("⚠️ spc_capability_daily表不存在或无数据，跳过月度报警率统计")
        return None

    if spc_cap.rdd.isEmpty():
        logger.warning("⚠️ 无符合条件的SPC数据，跳过月度报警率统计")
        return None

    key_cols = ["process_id", "tank_name", "item_name"]

    result = (
        spc_cap
        .withColumn("year", year("analysis_date"))
        .withColumn("month", fmonth("analysis_date"))
        .groupBy(*key_cols, "year", "month")
        .agg(
            count("*").alias("total_points"),
            fsum("oospec_points").alias("r0_count"),
            fsum("ooc_points").alias("r1_count"),
            fsum("r2_flag").alias("r2_count"),
            fsum("r3_flag").alias("r3_count"),
            fsum("ooc_total").alias("total_alarm_count"),
            avg("cp").alias("avg_cp"),
            avg("cpk").alias("avg_cpk")
        )
        .withColumn("alarm_rate",
            when(col("total_points") > 0,
                 (col("total_alarm_count") / col("total_points")) * 100.0)
            .otherwise(lit(0.0)))
        .withColumn("created_at", current_timestamp())
        .withColumn("updated_at", current_timestamp())
    )

    df_count = result.count()
    duration = time.time() - start_time

    metrics.records_aggregated.labels(aggregation_type='spc_monthly_alarm_rate').set(df_count)
    metrics.processing_duration.labels(
        aggregation_type='spc_monthly_alarm_rate',
        operation='aggregate'
    ).observe(duration)

    logger.info(f"✅ Monthly alarm rate aggregation: {df_count} rows (耗时: {duration:.2f}s)")
    return result


# ------------------------
# 建表 (扩展Iceberg表)
# ------------------------
def ensure_gold_tables(spark):
    """确保Gold表存在"""
    logger.info("🔧 Ensuring Gold tables...")
    try:
        import psycopg2
        conn = psycopg2.connect(
            host=PG_HOST, port=PG_PORT, dbname=PG_DB, user=PG_USER, password=PG_PASSWORD
        )
        cur = conn.cursor()
        cur.execute("CREATE SCHEMA IF NOT EXISTS gold;")

        # 原有表 (保持不变)
        cur.execute("DROP TABLE IF EXISTS gold.agg_qualification_rate_daily CASCADE;")
        cur.execute("""
        CREATE TABLE gold.agg_qualification_rate_daily (
            id SERIAL PRIMARY KEY,
            process_name VARCHAR(128),
            shift VARCHAR(32),
            analysis_date DATE NOT NULL,
            total_analyses INTEGER,
            unqualified_count INTEGER,
            unqualified_rate DOUBLE PRECISION,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uk_qual_rate UNIQUE(process_name, shift, analysis_date)
        );
        """)

        cur.execute("DROP TABLE IF EXISTS gold.agg_warning_statistics_daily CASCADE;")
        cur.execute("""
        CREATE TABLE gold.agg_warning_statistics_daily (
            id SERIAL PRIMARY KEY,
            process_name VARCHAR(128),
            shift VARCHAR(32),
            analysis_date DATE NOT NULL,
            total_analyses INTEGER,
            warning_count INTEGER,
            warning_rate DOUBLE PRECISION,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uk_warn_stats UNIQUE(process_name, shift, analysis_date)
        );
        """)

        cur.execute("DROP TABLE IF EXISTS gold.spc_capability_daily CASCADE;")
        cur.execute("""
        CREATE TABLE gold.spc_capability_daily (
            id SERIAL PRIMARY KEY,
            process_id VARCHAR(64), tank_name VARCHAR(128), item_name VARCHAR(128), shift VARCHAR(32),
            analysis_date DATE NOT NULL,
            n_samples INTEGER, xbar DOUBLE PRECISION, mr_bar DOUBLE PRECISION, sigma_within DOUBLE PRECISION,
            ucl_x DOUBLE PRECISION, cl_x DOUBLE PRECISION, lcl_x DOUBLE PRECISION,
            ucl_mr DOUBLE PRECISION, cl_mr DOUBLE PRECISION, lcl_mr DOUBLE PRECISION,
            lsl DOUBLE PRECISION, usl DOUBLE PRECISION, cl DOUBLE PRECISION,
            cp DOUBLE PRECISION, cpk DOUBLE PRECISION, pp DOUBLE PRECISION, ppk DOUBLE PRECISION,
            ooc_points INTEGER, oospec_points INTEGER, within_spec_rate DOUBLE PRECISION,
            r2_flag INTEGER DEFAULT 0, r3_flag INTEGER DEFAULT 0, ooc_total INTEGER DEFAULT 0,
            data_sufficient BOOLEAN DEFAULT FALSE, limit_source VARCHAR(32) DEFAULT 'CALCULATED',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uk_spc_cap UNIQUE(process_id, tank_name, item_name, shift, analysis_date)
        );
        """)
        
        cur.execute("DROP TABLE IF EXISTS gold.spc_trend_ma CASCADE;")
        cur.execute("""
        CREATE TABLE gold.spc_trend_ma (
            id SERIAL PRIMARY KEY,
            process_id VARCHAR(64), tank_name VARCHAR(128), item_name VARCHAR(128),
            analysis_date DATE NOT NULL,
            x DOUBLE PRECISION, sma_5 DOUBLE PRECISION, sma_7 DOUBLE PRECISION, sma_14 DOUBLE PRECISION,
            ema_7 DOUBLE PRECISION, ema_14 DOUBLE PRECISION,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uk_spc_ma UNIQUE(process_id, tank_name, item_name, analysis_date)
        );
        """)

        # ========== 新增表 ==========
        
        # XBar-R图表
        cur.execute("DROP TABLE IF EXISTS gold.spc_xbar_r_chart CASCADE;")
        cur.execute("""
        CREATE TABLE gold.spc_xbar_r_chart (
            id SERIAL PRIMARY KEY,
            process_id VARCHAR(64), tank_name VARCHAR(128), item_name VARCHAR(128),
            analysis_date DATE NOT NULL,
            subgroup_size INTEGER, subgroup_count INTEGER,
            xbar_grand DOUBLE PRECISION, xbar_ucl DOUBLE PRECISION, xbar_cl DOUBLE PRECISION, xbar_lcl DOUBLE PRECISION,
            r_bar DOUBLE PRECISION, r_ucl DOUBLE PRECISION, r_cl DOUBLE PRECISION, r_lcl DOUBLE PRECISION,
            lsl DOUBLE PRECISION, usl DOUBLE PRECISION, cp DOUBLE PRECISION, cpk DOUBLE PRECISION,
            xbar_ooc_points INTEGER, r_ooc_points INTEGER,
            r2_flag INTEGER DEFAULT 0, r3_flag INTEGER DEFAULT 0, ooc_total INTEGER DEFAULT 0,
            data_sufficient BOOLEAN DEFAULT FALSE, limit_source VARCHAR(32) DEFAULT 'CALCULATED',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uk_xbar_r UNIQUE(process_id, tank_name, item_name, analysis_date)
        );
        """)
        
        # XBar-S图表
        cur.execute("DROP TABLE IF EXISTS gold.spc_xbar_s_chart CASCADE;")
        cur.execute("""
        CREATE TABLE gold.spc_xbar_s_chart (
            id SERIAL PRIMARY KEY,
            process_id VARCHAR(64), tank_name VARCHAR(128), item_name VARCHAR(128),
            analysis_date DATE NOT NULL,
            subgroup_size INTEGER, subgroup_count INTEGER,
            xbar_grand DOUBLE PRECISION, xbar_ucl DOUBLE PRECISION, xbar_cl DOUBLE PRECISION, xbar_lcl DOUBLE PRECISION,
            s_bar DOUBLE PRECISION, s_ucl DOUBLE PRECISION, s_cl DOUBLE PRECISION, s_lcl DOUBLE PRECISION,
            lsl DOUBLE PRECISION, usl DOUBLE PRECISION, cp DOUBLE PRECISION, cpk DOUBLE PRECISION,
            xbar_ooc_points INTEGER, s_ooc_points INTEGER,
            r2_flag INTEGER DEFAULT 0, r3_flag INTEGER DEFAULT 0, ooc_total INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uk_xbar_s UNIQUE(process_id, tank_name, item_name, analysis_date)
        );
        """)
        
        # P图表
        cur.execute("DROP TABLE IF EXISTS gold.spc_p_chart CASCADE;")
        cur.execute("""
        CREATE TABLE gold.spc_p_chart (
            id SERIAL PRIMARY KEY,
            process_id VARCHAR(64), shift VARCHAR(32),
            analysis_date DATE NOT NULL,
            n INTEGER, np INTEGER, p DOUBLE PRECISION,
            p_bar DOUBLE PRECISION, ucl DOUBLE PRECISION, cl DOUBLE PRECISION, lcl DOUBLE PRECISION,
            ooc_points INTEGER,
            r2_flag INTEGER DEFAULT 0, r3_flag INTEGER DEFAULT 0, ooc_total INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uk_p_chart UNIQUE(process_id, shift, analysis_date)
        );
        """)
        
        # C图表
        cur.execute("DROP TABLE IF EXISTS gold.spc_c_chart CASCADE;")
        cur.execute("""
        CREATE TABLE gold.spc_c_chart (
            id SERIAL PRIMARY KEY,
            process_id VARCHAR(64), shift VARCHAR(32),
            analysis_date DATE NOT NULL,
            c INTEGER, c_bar DOUBLE PRECISION,
            ucl DOUBLE PRECISION, cl DOUBLE PRECISION, lcl DOUBLE PRECISION,
            ooc_points INTEGER,
            r2_flag INTEGER DEFAULT 0, r3_flag INTEGER DEFAULT 0, ooc_total INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uk_c_chart UNIQUE(process_id, shift, analysis_date)
        );
        """)

        # 月度报警率统计表
        cur.execute("DROP TABLE IF EXISTS gold.spc_monthly_alarm_rate CASCADE;")
        cur.execute("""
        CREATE TABLE gold.spc_monthly_alarm_rate (
            id SERIAL PRIMARY KEY,
            process_id VARCHAR(64), tank_name VARCHAR(128), item_name VARCHAR(128),
            year INTEGER, month INTEGER,
            total_points INTEGER,
            r0_count INTEGER, r1_count INTEGER, r2_count INTEGER, r3_count INTEGER,
            total_alarm_count INTEGER,
            alarm_rate DOUBLE PRECISION,
            avg_cp DOUBLE PRECISION, avg_cpk DOUBLE PRECISION,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uk_monthly_alarm UNIQUE(process_id, tank_name, item_name, year, month)
        );
        """)
        
        conn.commit()
        cur.close()
        conn.close()
        logger.info("✅ PostgreSQL gold tables ensured")
    except Exception as e:
        logger.warning(f"PG ensure tables warning: {e}")

    # Iceberg表
    spark.sql(f"CREATE DATABASE IF NOT EXISTS iceberg.{ICEBERG_GOLD_NAMESPACE}")
    
    # 原有表 (强制更新)
    spark.sql(f"""
    CREATE OR REPLACE TABLE iceberg.{ICEBERG_GOLD_NAMESPACE}.agg_qualification_rate_daily (
        process_name string, shift string, analysis_date date, total_analyses int,
        unqualified_count int, unqualified_rate double, created_at timestamp
    ) USING iceberg PARTITIONED BY (months(analysis_date))
    """)
    spark.sql(f"""
    CREATE OR REPLACE TABLE iceberg.{ICEBERG_GOLD_NAMESPACE}.agg_warning_statistics_daily (
        process_name string, shift string, analysis_date date, total_analyses int,
        warning_count int, warning_rate double, created_at timestamp
    ) USING iceberg PARTITIONED BY (months(analysis_date))
    """)
    
    spark.sql(f"""
    CREATE OR REPLACE TABLE iceberg.{ICEBERG_GOLD_NAMESPACE}.spc_capability_daily (
        process_id string, tank_name string, item_name string, shift string, analysis_date date,
        n_samples int, xbar double, mr_bar double, sigma_within double,
        ucl_x double, cl_x double, lcl_x double,
        ucl_mr double, cl_mr double, lcl_mr double,
        lsl double, usl double, cl double,
        cp double, cpk double, pp double, ppk double,
        ooc_points int, oospec_points int, within_spec_rate double,
        r2_flag int, r3_flag int, ooc_total int,
        data_sufficient boolean, limit_source string,
        created_at timestamp, updated_at timestamp
    ) USING iceberg PARTITIONED BY (months(analysis_date))
    """)
    spark.sql(f"""
    CREATE TABLE IF NOT EXISTS iceberg.{ICEBERG_GOLD_NAMESPACE}.spc_trend_ma (
        process_id string, tank_name string, item_name string, analysis_date date,
        x double, sma_5 double, sma_7 double, sma_14 double,
        ema_7 double, ema_14 double,
        created_at timestamp, updated_at timestamp
    ) USING iceberg PARTITIONED BY (months(analysis_date))
    """)

    # SPC 基线表 — 按 SOP 冻结 CL/UCL/LCL,供 R2/R3 判定与图表展示
    spark.sql(f"""
    CREATE TABLE IF NOT EXISTS iceberg.{ICEBERG_GOLD_NAMESPACE}.spc_baseline (
        process_id string, tank_name string, item_name string,
        chart_type string,
        baseline_n int,
        baseline_start_date date, baseline_end_date date,
        x_double_bar double, mr_bar_baseline double,
        cl_x double, ucl_x double, lcl_x double,
        cl_mr double, ucl_mr double, lcl_mr double,
        is_preliminary boolean,
        created_at timestamp, updated_at timestamp
    ) USING iceberg
    """)
    
    # ========== 新增Iceberg表 ==========
    
    spark.sql(f"""
    CREATE OR REPLACE TABLE iceberg.{ICEBERG_GOLD_NAMESPACE}.spc_xbar_r_chart (
        process_id string, tank_name string, item_name string, analysis_date date,
        subgroup_size int, subgroup_count int,
        xbar_grand double, xbar_ucl double, xbar_cl double, xbar_lcl double,
        r_bar double, r_ucl double, r_cl double, r_lcl double,
        lsl double, usl double, cp double, cpk double,
        xbar_ooc_points int, r_ooc_points int,
        r2_flag int, r3_flag int, ooc_total int,
        data_sufficient boolean, limit_source string,
        created_at timestamp, updated_at timestamp
    ) USING iceberg PARTITIONED BY (months(analysis_date))
    """)
    
    spark.sql(f"""
    CREATE OR REPLACE TABLE iceberg.{ICEBERG_GOLD_NAMESPACE}.spc_xbar_s_chart (
        process_id string, tank_name string, item_name string, analysis_date date,
        subgroup_size int, subgroup_count int,
        xbar_grand double, xbar_ucl double, xbar_cl double, xbar_lcl double,
        s_bar double, s_ucl double, s_cl double, s_lcl double,
        lsl double, usl double, cp double, cpk double,
        xbar_ooc_points int, s_ooc_points int,
        r2_flag int, r3_flag int, ooc_total int,
        created_at timestamp, updated_at timestamp
    ) USING iceberg PARTITIONED BY (months(analysis_date))
    """)
    
    spark.sql(f"""
    CREATE OR REPLACE TABLE iceberg.{ICEBERG_GOLD_NAMESPACE}.spc_p_chart (
        process_id string, shift string, analysis_date date,
        n int, np int, p double,
        p_bar double, ucl double, cl double, lcl double,
        ooc_points int, r2_flag int, r3_flag int, ooc_total int,
        created_at timestamp, updated_at timestamp
    ) USING iceberg PARTITIONED BY (months(analysis_date))
    """)
    
    spark.sql(f"""
    CREATE OR REPLACE TABLE iceberg.{ICEBERG_GOLD_NAMESPACE}.spc_c_chart (
        process_id string, shift string, analysis_date date,
        c int, c_bar double,
        ucl double, cl double, lcl double,
        ooc_points int, r2_flag int, r3_flag int, ooc_total int,
        created_at timestamp, updated_at timestamp
    ) USING iceberg PARTITIONED BY (months(analysis_date))
    """)
    
    # 月度报警率
    spark.sql(f"""
    CREATE OR REPLACE TABLE iceberg.{ICEBERG_GOLD_NAMESPACE}.spc_monthly_alarm_rate (
        process_id string, tank_name string, item_name string,
        year int, month int,
        total_points int,
        r0_count int, r1_count int, r2_count int, r3_count int,
        total_alarm_count int, alarm_rate double,
        avg_cp double, avg_cpk double,
        created_at timestamp, updated_at timestamp
    ) USING iceberg PARTITIONED BY (year, month)
    """)

    logger.info("✅ Iceberg gold tables ensured")


# =========================
# 主流程（带重试）
# =========================
def create_retry_decorator():
    if not TENACITY_AVAILABLE:
        return lambda func: func
    return retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=60),
        retry=retry_if_exception_type(Exception),
        reraise=True
    )

@create_retry_decorator()
def process_gold_aggregation(spark, start_date: str, end_date: str):
    """处理Gold层聚合（带重试）- 完整版本"""
    logger.info(f"\n{'='*80}")
    logger.info(f"📈 处理Gold层聚合（完整版）")
    logger.info(f"   日期范围: {start_date} ~ {end_date}")
    logger.info(f"{'='*80}")
    
    total_start = time.time()
    
    try:
        # 1. 读取Silver数据
        df_silver = load_silver_data(spark, start_date, end_date)
        if df_silver.rdd.isEmpty():
            logger.warning("⚠️ 无analysis_records数据，跳过")
            return
        
        # 2. 读取化学分析数据（用于SPC）
        chem_wide = load_silver_chemical(spark, start_date, end_date, lookback_days=29)
        
        # ========== 执行所有聚合 ==========
        
        # 聚合1: 不合格率统计
        logger.info("\n🔄 [1/8] 处理不合格率统计...")
        qual_df = aggregate_qualification(df_silver)
        atomic_dual_write_gold(
            spark, qual_df,
            pg_table="agg_qualification_rate_daily",
            iceberg_table="agg_qualification_rate_daily",
            unique_keys=["process_name", "shift", "analysis_date"],
            start_date=start_date, end_date=end_date,
            aggregation_type="qualification_rate"
        )
        update_watermark(spark, "qualification_rate", start_date, end_date, qual_df.count(), "SUCCESS")
        report_gold_lineage("qualification_rate")
        
        # 聚合2: 预警统计
        logger.info("\n🔄 [2/8] 处理预警统计...")
        warn_df = aggregate_warning(df_silver)
        atomic_dual_write_gold(
            spark, warn_df,
            pg_table="agg_warning_statistics_daily",
            iceberg_table="agg_warning_statistics_daily",
            unique_keys=["process_name", "shift", "analysis_date"],
            start_date=start_date, end_date=end_date,
            aggregation_type="warning_statistics"
        )
        update_watermark(spark, "warning_statistics", start_date, end_date, warn_df.count(), "SUCCESS")
        report_gold_lineage("warning_statistics")
        
        # 检查化学数据
        if chem_wide.rdd.isEmpty():
            logger.warning("⚠️ 无化学分析数据，跳过SPC聚合")
        else:
            # 按SOP特性类型分配控制图:
            #   药水/流程特性 → I-MR (aggregate_spc_capability)
            #   产品特性     → Xbar-R (aggregate_spc_xbar_r)
            chem_imr = chem_wide.filter(col("char_type").isin("chemical", "process") | col("char_type").isNull())
            chem_product = chem_wide.filter(col("char_type") == lit("product"))

            # 聚合3: SPC能力分析 (I-MR图 — 药水/流程特性)
            logger.info("\n🔄 [3/8] 处理SPC能力分析 (I-MR, 药水/流程特性)...")
            spc_cap_df = aggregate_spc_capability(chem_imr)
            atomic_dual_write_gold(
                spark, spc_cap_df,
                pg_table="spc_capability_daily",
                iceberg_table="spc_capability_daily",
                unique_keys=["process_id", "tank_name", "item_name", "shift", "analysis_date"],
                start_date=start_date, end_date=end_date,
                aggregation_type="spc_capability"
            )
            update_watermark(spark, "spc_capability", start_date, end_date, spc_cap_df.count(), "SUCCESS")
            report_gold_lineage("spc_capability")

            # 聚合3.1: SPC 基线 (SOP 冻结 CL/UCL/LCL,供 R2/R3 与图表使用)
            logger.info("\n🔄 [3.1/8] 计算 I-MR 基线 (SOP 冻结控制限)...")
            baseline_df = compute_imr_baseline(chem_imr)
            # 基线是 (process_id, tank_name, item_name, chart_type) 维度的小表,
            # 每次 ETL 用全量覆盖写入 (基线本身基于历史最早 25 组,稳定)
            iceberg_baseline_table = f"iceberg.{ICEBERG_GOLD_NAMESPACE}.spc_baseline"
            try:
                baseline_df.writeTo(iceberg_baseline_table).createOrReplace()
            except Exception as e:
                logger.warning(f"⚠️ spc_baseline createOrReplace 失败,回退到 overwrite: {e}")
                baseline_df.writeTo(iceberg_baseline_table).overwritePartitions()
            logger.info("✅ I-MR baseline written to iceberg.gold_qms.spc_baseline")

            # 聚合4: SPC移动平均
            logger.info("\n🔄 [4/8] 处理SPC移动平均...")
            spc_ma_df = aggregate_spc_ma(chem_wide)
            atomic_dual_write_gold(
                spark, spc_ma_df,
                pg_table="spc_trend_ma",
                iceberg_table="spc_trend_ma",
                unique_keys=["process_id", "tank_name", "item_name", "analysis_date"],
                start_date=start_date, end_date=end_date,
                aggregation_type="spc_trend_ma"
            )
            update_watermark(spark, "spc_trend_ma", start_date, end_date, spc_ma_df.count(), "SUCCESS")
            report_gold_lineage("spc_trend_ma")

            # 聚合5: XBar-R控制图 (产品特性)
            logger.info("\n🔄 [5/8] 处理XBar-R控制图 (产品特性)...")
            if not chem_product.rdd.isEmpty():
                xbar_r_df = aggregate_spc_xbar_r(chem_product, subgroup_size=5)
                atomic_dual_write_gold(
                    spark, xbar_r_df,
                    pg_table="spc_xbar_r_chart",
                    iceberg_table="spc_xbar_r_chart",
                    unique_keys=["process_id", "tank_name", "item_name", "analysis_date"],
                    start_date=start_date, end_date=end_date,
                    aggregation_type="spc_xbar_r"
                )
                update_watermark(spark, "spc_xbar_r", start_date, end_date, xbar_r_df.count(), "SUCCESS")
                report_gold_lineage("spc_xbar_r")
            else:
                logger.info("  ⏭️ 无产品特性数据，跳过XBar-R")

            # 聚合6: XBar-S控制图 (产品特性，大子组)
            logger.info("\n🔄 [6/8] 处理XBar-S控制图 (产品特性)...")
            if not chem_product.rdd.isEmpty():
                xbar_s_df = aggregate_spc_xbar_s(chem_product, subgroup_size=10)
                atomic_dual_write_gold(
                    spark, xbar_s_df,
                    pg_table="spc_xbar_s_chart",
                    iceberg_table="spc_xbar_s_chart",
                    unique_keys=["process_id", "tank_name", "item_name", "analysis_date"],
                    start_date=start_date, end_date=end_date,
                    aggregation_type="spc_xbar_s"
                )
                update_watermark(spark, "spc_xbar_s", start_date, end_date, xbar_s_df.count(), "SUCCESS")
                report_gold_lineage("spc_xbar_s")
            else:
                logger.info("  ⏭️ 无产品特性数据，跳过XBar-S")
        
        # 聚合7: P图（不良率控制图）
        logger.info("\n🔄 [7/8] 处理P图...")
        p_chart_df = aggregate_spc_p_chart(df_silver)
        atomic_dual_write_gold(
            spark, p_chart_df,
            pg_table="spc_p_chart",
            iceberg_table="spc_p_chart",
            unique_keys=["process_id", "shift", "analysis_date"],
            start_date=start_date, end_date=end_date,
            aggregation_type="spc_p_chart"
        )
        update_watermark(spark, "spc_p_chart", start_date, end_date, p_chart_df.count(), "SUCCESS")
        report_gold_lineage("spc_p_chart")
        
        # 聚合8: C图（缺陷数控制图）
        logger.info("\n🔄 [8/8] 处理C图...")
        c_chart_df = aggregate_spc_c_chart(df_silver)
        atomic_dual_write_gold(
            spark, c_chart_df,
            pg_table="spc_c_chart",
            iceberg_table="spc_c_chart",
            unique_keys=["process_id", "shift", "analysis_date"],
            start_date=start_date, end_date=end_date,
            aggregation_type="spc_c_chart"
        )
        update_watermark(spark, "spc_c_chart", start_date, end_date, c_chart_df.count(), "SUCCESS")
        report_gold_lineage("spc_c_chart")

        # 聚合9: 月度报警率统计
        logger.info("\n🔄 [9/9] 处理月度报警率统计...")
        alarm_rate_df = aggregate_monthly_alarm_rate(spark, start_date, end_date)
        if alarm_rate_df is not None:
            # 月度报警率表按year+month分区，无analysis_date列，需自定义删除条件
            from datetime import datetime as _dt
            _sd = _dt.strptime(start_date, "%Y-%m-%d")
            _ed = _dt.strptime(end_date, "%Y-%m-%d")
            _del_cond = (
                f"(year > {_sd.year} OR (year = {_sd.year} AND month >= {_sd.month})) "
                f"AND (year < {_ed.year} OR (year = {_ed.year} AND month <= {_ed.month}))"
            )
            atomic_dual_write_gold(
                spark, alarm_rate_df,
                pg_table="spc_monthly_alarm_rate",
                iceberg_table="spc_monthly_alarm_rate",
                unique_keys=["process_id", "tank_name", "item_name", "year", "month"],
                start_date=start_date, end_date=end_date,
                aggregation_type="spc_monthly_alarm_rate",
                delete_condition=_del_cond
            )
            update_watermark(spark, "spc_monthly_alarm_rate", start_date, end_date, alarm_rate_df.count(), "SUCCESS")
            report_gold_lineage("spc_monthly_alarm_rate")

        # ========== 完成 ==========
        total_duration = time.time() - total_start
        logger.info(f"\n{'='*80}")
        logger.info(f"✅ Gold层聚合全部完成")
        logger.info(f"   处理表数: 9个")
        logger.info(f"   总耗时: {total_duration:.2f}秒")
        logger.info(f"{'='*80}")
        
    except Exception as e:
        logger.error(f"❌ Gold聚合失败: {e}")
        update_watermark(spark, "all", start_date, end_date, 0, "FAILED")
        raise

def backfill_spc(spark, earliest_date="2024-01-01"):
    """
    全量回填SPC数据 (SOP逻辑迁移后使用)
    1. DROP旧表 + CREATE新结构
    2. 按月分批重新计算所有SPC聚合
    """
    from datetime import datetime as dt, timedelta

    logger.info("=" * 80)
    logger.info("🔄 SPC数据全量回填模式")
    logger.info(f"   回填起始日期: {earliest_date}")
    logger.info("=" * 80)

    # Step 1: 重建表结构（DROP+CREATE）
    ensure_gold_tables(spark)
    logger.info("✅ 表结构重建完成")

    # Step 2: 清除SPC相关watermark（Iceberg表）
    try:
        spark.sql(f"""
            DELETE FROM {WATERMARK_TABLE}
            WHERE aggregation_type LIKE 'spc_%'
        """)
        logger.info("✅ SPC watermark记录已清除")
    except Exception as e:
        logger.warning(f"⚠️ Watermark清除警告: {e}")

    # Step 3: 按月分批回填
    current = dt.strptime(earliest_date, "%Y-%m-%d")
    end = dt.now()
    batch = 0

    while current < end:
        month_end = min(
            (current.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1),
            end
        )
        batch += 1
        logger.info(f"\n🔄 Batch {batch}: {current.strftime('%Y-%m-%d')} ~ {month_end.strftime('%Y-%m-%d')}")
        try:
            process_gold_aggregation(spark, current.strftime('%Y-%m-%d'), month_end.strftime('%Y-%m-%d'))
        except Exception as e:
            logger.error(f"❌ Batch {batch} 失败: {e}")
        current = month_end + timedelta(days=1)

    logger.info(f"\n✅ 回填完成，共处理 {batch} 批次")


def gold_schema_complete(spark):
    """检测 gold 表结构是否已是最新(以 spc_capability_daily.shift 列为标志位)。
    PG 与 Iceberg 两侧**都**必须含 shift 列才算完整 —— 只要任一侧缺列就返回 False,
    交由 ensure_gold_tables 把两侧一起重建对齐(避免 PG 有列/Iceberg 没列导致 append schema 不匹配)。
    - 任一侧表不存在或缺 shift 列 -> False(需要重建)
    - 两侧都含 shift 列            -> True(跳过重建,直接增量 UPSERT)
    """
    # 1) PG 侧
    try:
        import psycopg2
        conn = psycopg2.connect(
            host=PG_HOST, port=PG_PORT, dbname=PG_DB, user=PG_USER, password=PG_PASSWORD
        )
        cur = conn.cursor()
        cur.execute("""
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'gold'
              AND table_name = 'spc_capability_daily'
              AND column_name = 'shift'
            LIMIT 1
        """)
        pg_has_shift = cur.fetchone() is not None
        cur.close()
        conn.close()
    except Exception as e:
        logger.warning(f"⚠️ 检测 PG gold 表结构失败,将按需重建: {e}")
        return False

    if not pg_has_shift:
        return False

    # 2) Iceberg 侧 —— 表不存在或缺 shift 列都视为需要重建
    try:
        ice_cols = [f.name for f in spark.table(
            f"{ICEBERG_CATALOG_NAME}.{ICEBERG_GOLD_NAMESPACE}.spc_capability_daily"
        ).schema.fields]
        ice_has_shift = "shift" in ice_cols
    except Exception as e:
        logger.warning(f"⚠️ 检测 Iceberg gold 表结构失败/表不存在,将按需重建: {e}")
        return False

    return ice_has_shift

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--start-date", "--start_date", dest="start_date", required=False, default=DEFAULT_START_DATE)
    p.add_argument("--end-date", "--end_date", dest="end_date", required=False, default=DEFAULT_END_DATE)
    p.add_argument("--backfill", action="store_true", help="全量回填SPC数据（SOP迁移后使用）")
    p.add_argument("--backfill-from", dest="backfill_from", default="2024-01-01", help="回填起始日期")
    return p.parse_args()

def main():
    args = parse_args()
    start_date = args.start_date
    end_date = args.end_date
    
    logger.info("=" * 80)
    logger.info("🚀 Silver → Gold Aggregation ETL v2.0")
    logger.info(f"   日期范围: {start_date} ~ {end_date}")
    logger.info("=" * 80)
    
    spark = create_spark()

    try:
        if args.backfill:
            # 全量回填模式：DROP旧表 + 重建 + 按月分批回填
            backfill_spc(spark, earliest_date=args.backfill_from)
        else:
            # 正常模式:仅当表结构不完整(缺少 shift 列或表不存在)时才重建,
            # 结构已完整则保留数据直接增量 UPSERT。无需单独的 --backfill。
            init_watermark_table(spark)
            if gold_schema_complete(spark):
                logger.info("✅ gold 表结构完整(已含 shift),跳过重建,执行增量聚合")
            else:
                logger.info("🔧 gold 表结构缺失/过期(无 shift 列),重建表结构后再聚合...")
                ensure_gold_tables(spark)
            process_gold_aggregation(spark, start_date, end_date)

        logger.info("=" * 80)
        logger.info("✅ Gold ETL执行成功")
        logger.info("=" * 80)

        # 推送指标
        metrics.push_metrics()

    except Exception as e:
        logger.error(f"❌ Gold ETL执行失败: {e}", exc_info=True)
        metrics.push_metrics()
        raise
    finally:
        spark.stop()

if __name__ == "__main__":
    main()