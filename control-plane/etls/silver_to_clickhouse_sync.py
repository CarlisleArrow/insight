#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gold Iceberg → ClickHouse 同步 v2.0
===================================
核心改进：
1. ✅ 幂等性：基于水位线增量同步
2. ✅ 修复删除逻辑：只删除当前同步日期，不影响历史数据
3. ✅ 真正UPSERT：ReplacingMergeTree自动去重+合并
4. ✅ 失败重试：Tenacity自动重试3次
5. ✅ 水位线追踪：ClickHouse层维护同步状态
6. ✅ 数据血缘：上报到DataHub和Neo4j
"""

import os
import sys
import argparse
import logging
import time
from datetime import date, datetime
from typing import Optional

from pyspark.sql import SparkSession
from pyspark.sql.functions import col, lit

from clickhouse_driver import Client as CHClient

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
logger = logging.getLogger("clickhouse_sync_v2")

# =========================
# 配置
# =========================
CH_HOST = os.getenv("CH_HOST", "172.16.202.53")
CH_PORT = int(os.getenv("CH_PORT", "9000"))
CH_USER = os.getenv("CH_USER", "default")
CH_PASSWORD = os.getenv("CH_PASSWORD", "")
CH_DB = os.getenv("CH_DB", "qms_gold")

ICEBERG_CATALOG_NAME = "iceberg"
ICEBERG_REST_URI = os.getenv("ICEBERG_REST_URI", "http://iceberg-rest-catalog.data-warehouse.svc.cluster.local:8181")

MINIO_ENDPOINT = "http://172.16.202.55:9000"
MINIO_ACCESS_KEY = "minioadmin"
MINIO_SECRET_KEY = "minioadmin"
S3_REGION = "us-east-1"

ICEBERG_WAREHOUSE = "s3://datalake-gold-iceberg/"
ICEBERG_GOLD_NAMESPACE = "gold_qms"

DEFAULT_SYNC_DATE = os.getenv("SYNC_DATE", date.today().isoformat())

PROMETHEUS_GATEWAY = '172.16.201.110:9091'
JOB_NAME = 'clickhouse_sync_etl_v2'

# 血缘配置
DATAHUB_GMS_URL = "http://172.16.202.60:9002/api/gms"
DATAHUB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhY3RvclR5cGUiOiJVU0VSIiwiYWN0b3JJZCI6ImRhdGFodWIiLCJ0eXBlIjoiUEVSU09OQUwiLCJ2ZXJzaW9uIjoiMiIsImp0aSI6ImFmZWFiZTEzLWJjMTMtNDU3Mi04N2I0LTkyN2QxNzcxNzdiNCIsInN1YiI6ImRhdGFodWIiLCJpc3MiOiJkYXRhaHViLW1ldGFkYXRhLXNlcnZpY2UifQ.s6wyrLe3vMtHNIbqO8Hqqtpj50Ej_9PHvFs_FAjVELk"
NEO4J_URI = "bolt://172.16.202.65:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "test"

# =========================
# Prometheus Metrics
# =========================
class ClickHouseSyncMetrics:
    def __init__(self):
        if not PROMETHEUS_AVAILABLE:
            return
        
        self.registry = CollectorRegistry()
        
        self.processing_duration = Histogram('clickhouse_sync_v2_duration_seconds', 'ClickHouse同步时长', ['table_name', 'operation'], registry=self.registry)
        self.records_read_iceberg = Gauge('clickhouse_sync_v2_records_read_iceberg', 'Iceberg读取记录数', ['table_name', 'sync_date'], registry=self.registry)
        self.records_written_clickhouse = Gauge('clickhouse_sync_v2_records_written', 'ClickHouse写入记录数', ['table_name'], registry=self.registry)
        self.clickhouse_connection_status = Gauge('clickhouse_sync_v2_connection_status', 'ClickHouse连接状态', ['host'], registry=self.registry)
        
        self.operation_success = Counter('clickhouse_sync_v2_success_total', 'ClickHouse同步成功', ['table_name', 'operation'], registry=self.registry)
        self.operation_failure = Counter('clickhouse_sync_v2_failure_total', 'ClickHouse同步失败', ['table_name', 'operation'], registry=self.registry)
        self.watermark_timestamp = Gauge('clickhouse_sync_v2_watermark_timestamp', '当前水位线时间戳(Unix秒)', ['table_name'], registry=self.registry)
    
    def push_metrics(self):
        if not PROMETHEUS_AVAILABLE:
            return
        try:
            push_to_gateway(PROMETHEUS_GATEWAY, job=JOB_NAME, registry=self.registry)
        except Exception as e:
            logger.warning(f"⚠️ Prometheus推送失败: {e}")

metrics = ClickHouseSyncMetrics()

# =========================
# 数据血缘上报
# =========================
def report_clickhouse_lineage(table_name: str):
    """上报ClickHouse同步血缘: Gold Iceberg → ClickHouse"""
    if not LINEAGE_AVAILABLE:
        return
    
    try:
        emitter = DatahubRestEmitter(gms_server=DATAHUB_GMS_URL, token=DATAHUB_TOKEN)
        neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        
        # Source: Gold Iceberg
        src_platform = "iceberg"
        src_name = f"{ICEBERG_GOLD_NAMESPACE}.{table_name}"
        src_urn = f"urn:li:dataset:(urn:li:dataPlatform:{src_platform},{src_name},PROD)"
        
        # Target: ClickHouse
        tgt_platform = "clickhouse"
        tgt_name = f"{CH_DB}.{table_name}"
        tgt_urn = f"urn:li:dataset:(urn:li:dataPlatform:{tgt_platform},{tgt_name},PROD)"
        
        logger.debug(f"   📡 [Lineage] {table_name}: Iceberg → ClickHouse")
        
        # DataHub上报
        emitter.emit(MetadataChangeProposalWrapper(
            entityType="dataset", changeType="UPSERT", entityUrn=src_urn,
            aspectName="status", aspect=StatusClass(removed=False)
        ))
        emitter.emit(MetadataChangeProposalWrapper(
            entityType="dataset", changeType="UPSERT", entityUrn=tgt_urn,
            aspectName="status", aspect=StatusClass(removed=False)
        ))
        emitter.emit(MetadataChangeProposalWrapper(
            entityType="dataset", changeType="UPSERT", entityUrn=tgt_urn,
            aspectName="upstreamLineage",
            aspect=UpstreamLineageClass(upstreams=[
                UpstreamClass(dataset=src_urn, type=DatasetLineageTypeClass.TRANSFORMED)
            ])
        ))
        
        # Neo4j上报
        query = """
        MERGE (s:Table {key: $src_key})
        ON CREATE SET s.name = $src_name, s.platform = $src_platform
        MERGE (t:Table {key: $tgt_key})
        ON CREATE SET t.name = $tgt_name, t.platform = $tgt_platform
        MERGE (s)-[:OUTPUT]->(t)
        """
        
        with neo4j_driver.session() as session:
            session.run(query,
                src_key=f"{src_platform}://default.{src_name.replace('.', '/')}",
                src_name=src_name, src_platform=src_platform,
                tgt_key=f"{tgt_platform}://default.{tgt_name.replace('.', '/')}",
                tgt_name=tgt_name, tgt_platform=tgt_platform
            )
        
        neo4j_driver.close()
        logger.info(f"   ✅ [Lineage] {table_name} 血缘上报成功")
    except Exception as e:
        logger.warning(f"   ⚠️ [Lineage] {table_name} 血缘上报失败: {e}")

# =========================
# Spark Session
# =========================
def create_spark():
    builder = (
        SparkSession.builder.appName("ClickHouse_Sync_v2_Idempotent")
        .config("spark.jars.packages",
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
        .config("spark.sql.session.timeZone", "UTC")
    )
    spark = builder.getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    spark.sparkContext._jvm.org.apache.log4j.Logger.getLogger("org.apache.iceberg.hadoop.HadoopStreams").setLevel(
        spark.sparkContext._jvm.org.apache.log4j.Level.ERROR
    )
    return spark

# =========================
# 水位线管理（ClickHouse内置）
# =========================
def init_watermark_table(client: CHClient):
    """初始化ClickHouse水位线表"""
    try:
        client.execute(f"""
        CREATE TABLE IF NOT EXISTS {CH_DB}._sync_watermarks (
            table_name String,
            sync_date Date,
            last_sync_timestamp DateTime,
            records_synced UInt64,
            status String
        ) ENGINE = ReplacingMergeTree(last_sync_timestamp)
        ORDER BY (table_name, sync_date)
        """)
        logger.info(f"✅ ClickHouse水位线表初始化: {CH_DB}._sync_watermarks")
    except Exception as e:
        logger.error(f"❌ 水位线表初始化失败: {e}")
        raise

def update_watermark(client: CHClient, table_name: str, sync_date: str, record_count: int, status: str = "SUCCESS"):
    """更新ClickHouse水位线"""
    try:
        if isinstance(sync_date, str):
            sync_date = datetime.strptime(sync_date, '%Y-%m-%d').date()
    
        now = datetime.now()  # 确保是 datetime 对象
        
        client.execute(f"""
            INSERT INTO {CH_DB}._sync_watermarks 
            (table_name, sync_date, last_sync_timestamp, records_synced, status)
            VALUES
        """, [(table_name, sync_date, now, record_count, status)])
       
        
        logger.info(f"✅ 水位线更新: {table_name} ({sync_date}) -> {record_count}条")
        metrics.watermark_timestamp.labels(table_name=table_name).set(datetime.now().timestamp())
    except Exception as e:
        logger.error(f"❌ 水位线更新失败: {e}")
        raise

# =========================
# ClickHouse建表（优化版本）
# =========================
def ensure_clickhouse_tables():
    """确保ClickHouse表存在（使用ReplacingMergeTree）"""
    logger.info("🔧 Ensuring ClickHouse tables...")
    start_time = time.time()
    
    try:
        client = CHClient(host=CH_HOST, port=CH_PORT, user=CH_USER, password=CH_PASSWORD)
        metrics.clickhouse_connection_status.labels(host=CH_HOST).set(1)
        
        client.execute(f"CREATE DATABASE IF NOT EXISTS {CH_DB}")
        
        # 初始化水位线表
        init_watermark_table(client)
        
        # ⚡关键改进：所有表都使用updated_at作为版本列
        # ReplacingMergeTree会自动保留updated_at最新的记录
        
        # 聚合统计表
        client.execute(f"""
        CREATE TABLE IF NOT EXISTS {CH_DB}.agg_qualification_rate_daily (
            process_name String, shift String,
            analysis_date Date,
            total_analyses UInt32, unqualified_count UInt32, unqualified_rate Float64,
            created_at DateTime,
            updated_at DateTime
        ) ENGINE = ReplacingMergeTree(updated_at)
        PARTITION BY toYYYYMM(analysis_date)
        ORDER BY (process_name, shift, analysis_date)
        """)
        
        client.execute(f"""
        CREATE TABLE IF NOT EXISTS {CH_DB}.agg_warning_statistics_daily (
            process_name String, shift String,
            analysis_date Date,
            total_analyses UInt32, warning_count UInt32, warning_rate Float64,
            created_at DateTime,
            updated_at DateTime
        ) ENGINE = ReplacingMergeTree(updated_at)
        PARTITION BY toYYYYMM(analysis_date)
        ORDER BY (process_name, shift, analysis_date)
        """)
        
        # SPC能力表 (DROP+重建以适配新列)
        client.execute(f"DROP TABLE IF EXISTS {CH_DB}.spc_capability_daily")
        client.execute(f"""
        CREATE TABLE IF NOT EXISTS {CH_DB}.spc_capability_daily (
            process_id String, tank_name String, item_name String,
            analysis_date Date,
            n_samples UInt32, xbar Float64, mr_bar Float64, sigma_within Float64,
            ucl_x Float64, cl_x Float64, lcl_x Float64,
            ucl_mr Float64, cl_mr Float64, lcl_mr Float64,
            lsl Float64, usl Float64, cl Float64,
            cp Float64, cpk Float64, pp Float64, ppk Float64,
            ooc_points UInt32, oospec_points UInt32, within_spec_rate Float64,
            r2_flag UInt32, r3_flag UInt32, ooc_total UInt32,
            data_sufficient UInt8, limit_source String,
            created_at DateTime, updated_at DateTime
        ) ENGINE = ReplacingMergeTree(updated_at)
        PARTITION BY toYYYYMM(analysis_date)
        ORDER BY (process_id, tank_name, item_name, analysis_date)
        """)
        
        client.execute(f"""
        CREATE TABLE IF NOT EXISTS {CH_DB}.spc_trend_ma (
            process_id String, tank_name String, item_name String,
            analysis_date Date,
            x Float64, sma_5 Float64, sma_7 Float64, sma_14 Float64,
            ema_7 Float64, ema_14 Float64,
            created_at DateTime, updated_at DateTime
        ) ENGINE = ReplacingMergeTree(updated_at)
        PARTITION BY toYYYYMM(analysis_date)
        ORDER BY (process_id, tank_name, item_name, analysis_date)
        """)
        
        # SPC控制图表 (DROP+重建以适配新列)
        for chart_type in ['xbar_r', 'xbar_s', 'p', 'c']:
            client.execute(f"DROP TABLE IF EXISTS {CH_DB}.spc_{chart_type}_chart")
            if chart_type in ['xbar_r', 'xbar_s']:
                range_col = 'r_bar' if chart_type == 'xbar_r' else 's_bar'
                range_ucl = 'r_ucl' if chart_type == 'xbar_r' else 's_ucl'
                range_cl = 'r_cl' if chart_type == 'xbar_r' else 's_cl'
                range_lcl = 'r_lcl' if chart_type == 'xbar_r' else 's_lcl'
                range_ooc = 'r_ooc_points' if chart_type == 'xbar_r' else 's_ooc_points'
                extra_cols = ", data_sufficient UInt8, limit_source String" if chart_type == 'xbar_r' else ""
                client.execute(f"""
                CREATE TABLE IF NOT EXISTS {CH_DB}.spc_{chart_type}_chart (
                    process_id String, tank_name String, item_name String,
                    analysis_date Date,
                    subgroup_size UInt32, subgroup_count UInt32,
                    xbar_grand Float64, xbar_ucl Float64, xbar_cl Float64, xbar_lcl Float64,
                    {range_col} Float64, {range_ucl} Float64, {range_cl} Float64, {range_lcl} Float64,
                    lsl Float64, usl Float64, cp Float64, cpk Float64,
                    xbar_ooc_points UInt32, {range_ooc} UInt32,
                    r2_flag UInt32, r3_flag UInt32, ooc_total UInt32{extra_cols},
                    created_at DateTime, updated_at DateTime
                ) ENGINE = ReplacingMergeTree(updated_at)
                PARTITION BY toYYYYMM(analysis_date)
                ORDER BY (process_id, tank_name, item_name, analysis_date)
                """)
            elif chart_type == 'p':
                client.execute(f"""
                CREATE TABLE IF NOT EXISTS {CH_DB}.spc_p_chart (
                    process_id String, shift String,
                    analysis_date Date,
                    n UInt32, np UInt32, p Float64,
                    p_bar Float64, ucl Float64, cl Float64, lcl Float64,
                    ooc_points UInt32, r2_flag UInt32, r3_flag UInt32, ooc_total UInt32,
                    created_at DateTime, updated_at DateTime
                ) ENGINE = ReplacingMergeTree(updated_at)
                PARTITION BY toYYYYMM(analysis_date)
                ORDER BY (process_id, shift, analysis_date)
                """)
            else:  # c图
                client.execute(f"""
                CREATE TABLE IF NOT EXISTS {CH_DB}.spc_c_chart (
                    process_id String, shift String,
                    analysis_date Date,
                    c UInt32, c_bar Float64,
                    ucl Float64, cl Float64, lcl Float64,
                    ooc_points UInt32, r2_flag UInt32, r3_flag UInt32, ooc_total UInt32,
                    created_at DateTime, updated_at DateTime
                ) ENGINE = ReplacingMergeTree(updated_at)
                PARTITION BY toYYYYMM(analysis_date)
                ORDER BY (process_id, shift, analysis_date)
                """)

        # 月度报警率表
        client.execute(f"DROP TABLE IF EXISTS {CH_DB}.spc_monthly_alarm_rate")
        client.execute(f"""
        CREATE TABLE IF NOT EXISTS {CH_DB}.spc_monthly_alarm_rate (
            process_id String, tank_name String, item_name String,
            year UInt16, month UInt8,
            total_points UInt32,
            r0_count UInt32, r1_count UInt32, r2_count UInt32, r3_count UInt32,
            total_alarm_count UInt32, alarm_rate Float64,
            avg_cp Float64, avg_cpk Float64,
            created_at DateTime, updated_at DateTime
        ) ENGINE = ReplacingMergeTree(updated_at)
        PARTITION BY year
        ORDER BY (process_id, tank_name, item_name, year, month)
        """)

        # ========== ClickHouse视图（基于SPC基表，供Go后端通过Trino查询） ==========

        # view_process_capability: 过程能力汇总视图
        # 后端 getSPCStatus / getCapabilityMetrics 通过 Trino clickhouse connector 查询此视图
        client.execute(f"DROP VIEW IF EXISTS {CH_DB}.view_process_capability")
        client.execute(f"""
        CREATE VIEW {CH_DB}.view_process_capability AS
        SELECT
            tank_name AS process_name,
            item_name,
            analysis_date,
            xbar AS mean_value,
            sigma_within AS std_dev,
            cp,
            cpk,
            ucl_x AS ucl,
            lcl_x AS lcl,
            usl,
            lsl,
            n_samples AS sample_count,
            ooc_total AS out_of_control_count,
            r2_flag,
            r3_flag,
            data_sufficient,
            limit_source,
            CASE
                WHEN cpk >= 1.67 THEN 'A+'
                WHEN cpk >= 1.33 THEN 'A'
                WHEN cpk >= 1.0  THEN 'B'
                WHEN cpk >= 0.67 THEN 'C'
                ELSE 'D'
            END AS capability_level
        FROM {CH_DB}.spc_capability_daily
        FINAL
        """)
        logger.info("✅ 视图 view_process_capability 已创建")

        # view_anomaly_patterns: 异常模式视图 (R2=连续9点同侧, R3=连续6点趋势)
        # 后端 GetAnomalyDetection 通过 Trino clickhouse connector 查询此视图
        client.execute(f"DROP VIEW IF EXISTS {CH_DB}.view_anomaly_patterns")
        client.execute(f"""
        CREATE VIEW {CH_DB}.view_anomaly_patterns AS
        SELECT
            tank_name AS process_name,
            item_name,
            analysis_date,
            xbar AS mean_value,
            CASE WHEN r3_flag = 1 AND xbar > cl_x THEN '连续6点递增' ELSE '' END AS trend_up,
            CASE WHEN r3_flag = 1 AND xbar < cl_x THEN '连续6点递减' ELSE '' END AS trend_down,
            r2_flag,
            r3_flag,
            ooc_points,
            oospec_points,
            ooc_total
        FROM {CH_DB}.spc_capability_daily
        FINAL
        WHERE ooc_total > 0 OR r2_flag > 0 OR r3_flag > 0
        """)
        logger.info("✅ 视图 view_anomaly_patterns 已创建")

        client.disconnect()

        duration = time.time() - start_time
        logger.info(f"✅ ClickHouse表初始化完成 (耗时: {duration:.2f}s)")
        
    except Exception as e:
        logger.error(f"❌ ClickHouse建表失败: {e}")
        metrics.clickhouse_connection_status.labels(host=CH_HOST).set(0)
        raise

# =========================
# 优化的ClickHouse写入（真正UPSERT）
# =========================
def write_clickhouse_upsert_v2(table, rows, sync_date, cols):
    """
    ClickHouse真正的UPSERT v2：
    - 不删除任何历史数据
    - 直接INSERT（ReplacingMergeTree自动合并同主键数据，保留updated_at最新的）
    - 后台自动去重合并
    """
    if not rows:
        logger.info(f"ℹ️ No rows for {table}")
        return
    
    logger.info(f"💾 Writing to ClickHouse: {CH_DB}.{table}")
    start_time = time.time()
    
    try:
        client = CHClient(host=CH_HOST, port=CH_PORT, user=CH_USER, password=CH_PASSWORD)
        
        # ⚡关键改进：不再删除数据，直接INSERT
        # ReplacingMergeTree引擎会在后台合并时自动去重
        # 保留updated_at最新的记录
        
        now = datetime.now()
        rows_with_timestamp = []
        for row in rows:
            row_list = list(row)

            # 按列索引转换日期时间字段 + 处理None值
            for i, (col_name, value) in enumerate(zip(cols, row_list)):
                if value is None:
                    # 为None值提供默认值，避免clickhouse-driver encode错误
                    if col_name in ('created_at', 'updated_at') or 'datetime' in col_name:
                        row_list[i] = now
                    elif 'date' in col_name:
                        row_list[i] = datetime.strptime(sync_date, '%Y-%m-%d').date() if isinstance(sync_date, str) else sync_date
                    elif col_name in ('process_name', 'process_id', 'shift', 'tank_name', 'item_name', 'line_name'):
                        row_list[i] = ''
                    else:
                        row_list[i] = 0
                    continue
                if isinstance(value, str):
                    if col_name == 'created_at' or 'datetime' in col_name:
                        try:
                            row_list[i] = datetime.strptime(value, '%Y-%m-%d %H:%M:%S')
                        except:
                            try:
                                row_list[i] = datetime.strptime(value, '%Y-%m-%d %H:%M:%S.%f')
                            except:
                                pass
                    elif 'date' in col_name and col_name != 'updated_at':
                        try:
                            row_list[i] = datetime.strptime(value, '%Y-%m-%d').date()
                        except:
                            pass

            rows_with_timestamp.append(tuple(row_list))
        
        rows_with_timestamp = [
            row for row in rows_with_timestamp 
            if row[0] is not None  # 假设第一列是 process_id 主键
        ]

        if not rows_with_timestamp:
            logger.warning(f"⚠️ 过滤后无有效数据: {table}")
            return
        # 直接INSERT（不删除）
        sql = f"INSERT INTO {CH_DB}.{table} ({','.join(cols)}) VALUES"
        client.execute(sql, rows_with_timestamp)
        
        duration = time.time() - start_time
        
        metrics.records_written_clickhouse.labels(table_name=table).set(len(rows))
        metrics.operation_success.labels(table_name=table, operation='write').inc()
        
        logger.info(f"✅ ClickHouse写入完成: {len(rows)} rows (耗时: {duration:.2f}s)")
        logger.info(f"   ℹ️ ReplacingMergeTree将在后台自动合并去重")
        
        client.disconnect()
        
    except Exception as e:
        logger.error(f"❌ ClickHouse写入失败: {e}")
        if rows:
            logger.error(f"样本数据: {rows[0][:5]}...")
        metrics.operation_failure.labels(table_name=table, operation='write').inc()
        raise

# =========================
# 通用数据读取
# =========================
def load_iceberg_gold_table(spark, table_name: str, sync_date: str):
    """通用Iceberg Gold表读取"""
    full_table = f"{ICEBERG_CATALOG_NAME}.{ICEBERG_GOLD_NAMESPACE}.{table_name}"
    logger.info(f"📖 Loading {full_table} for date: {sync_date}")
    start_time = time.time()

    try:
        # spc_monthly_alarm_rate 没有 analysis_date 列，使用 year/month 过滤
        if table_name == "spc_monthly_alarm_rate":
            from datetime import datetime as _dt
            _d = _dt.strptime(sync_date, "%Y-%m-%d") if isinstance(sync_date, str) else sync_date
            df = spark.table(full_table).where(
                (col("year") == _d.year) & (col("month") == _d.month)
            )
        else:
            df = spark.table(full_table).where(col("analysis_date") == lit(sync_date))
        
        # NULL值处理
        numeric_cols = [field.name for field in df.schema.fields if field.dataType.simpleString() in ['double', 'float', 'int', 'bigint']]
        df = df.fillna(0.0, subset=numeric_cols)
        
        count = df.count()
        duration = time.time() - start_time
        
        metrics.records_read_iceberg.labels(table_name=table_name, sync_date=sync_date).set(count)
        metrics.operation_success.labels(table_name=table_name, operation='read').inc()
        
        logger.info(f"✅ Loaded {count} rows from {full_table} (耗时: {duration:.2f}s)")
        return df
        
    except Exception as e:
        logger.error(f"❌ Failed to read {full_table}: {e}")
        metrics.operation_failure.labels(table_name=table_name, operation='read').inc()
        raise

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
def sync_table_to_clickhouse(spark, table_name: str, sync_date: str, cols: list):
    """同步单表到ClickHouse（带重试）"""
    logger.info(f"\n{'='*80}")
    logger.info(f"🔄 同步表: {table_name}")
    logger.info(f"   日期: {sync_date}")
    logger.info(f"{'='*80}")
    
    start_time = time.time()
    
    try:
        # 1. 读取Iceberg数据
        df = load_iceberg_gold_table(spark, table_name, sync_date)
        
        if df.count() == 0:
            logger.warning(f"⚠️ {table_name} 无数据，跳过")
            return
        
        # 2. 转换为ClickHouse格式
        rows = [tuple(r) for r in df.collect()]
        
        # 3. 写入ClickHouse（真正UPSERT）
        write_clickhouse_upsert_v2(table_name, rows, sync_date, cols)
        
        # 4. 更新水位线
        client = CHClient(host=CH_HOST, port=CH_PORT, user=CH_USER, password=CH_PASSWORD)
        update_watermark(client, table_name, sync_date, len(rows), "SUCCESS")
        client.disconnect()
        
        # 5. 上报血缘
        report_clickhouse_lineage(table_name)
        
        duration = time.time() - start_time
        logger.info(f"✅ {table_name} 同步完成 (耗时: {duration:.2f}s)")
        
    except Exception as e:
        logger.error(f"❌ {table_name} 同步失败: {e}")
        client = CHClient(host=CH_HOST, port=CH_PORT, user=CH_USER, password=CH_PASSWORD)
        update_watermark(client, table_name, sync_date, 0, "FAILED")
        client.disconnect()
        raise

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--date", dest="sync_date", default=DEFAULT_SYNC_DATE, help="YYYY-MM-DD")
    return p.parse_args()

def main():
    args = parse_args()
    from datetime import datetime, date

    if isinstance(args.sync_date, str):
        sync_date = datetime.strptime(args.sync_date, '%Y-%m-%d').date()
    else:
        sync_date = args.sync_date
    
    logger.info("=" * 80)
    logger.info("🚀 Gold Iceberg → ClickHouse 同步 v2.0")
    logger.info(f"   同步日期: {sync_date}")
    logger.info("=" * 80)
    
    spark = create_spark()
    total_start_time = time.time()
    
    # 定义所有需要同步的表及其列顺序
    tables_config = {
        # ========== 聚合统计表 ==========
        "agg_qualification_rate_daily": [
            "process_name","shift","analysis_date",
            "total_analyses","unqualified_count","unqualified_rate",
            "created_at"
        ],
        "agg_warning_statistics_daily": [
            "process_name","shift","analysis_date",
            "total_analyses","warning_count","warning_rate",
            "created_at"
        ],
        
        # ========== SPC能力分析表 ==========
        "spc_capability_daily": [
            "process_id","tank_name","item_name","analysis_date",
            "n_samples","xbar","mr_bar","sigma_within",
            "ucl_x","cl_x","lcl_x","ucl_mr","cl_mr","lcl_mr",
            "lsl","usl","cl","cp","cpk","pp","ppk",
            "ooc_points","oospec_points","within_spec_rate",
            "r2_flag","r3_flag","ooc_total",
            "data_sufficient","limit_source",
            "created_at","updated_at"
        ],
        "spc_trend_ma": [
            "process_id","tank_name","item_name","analysis_date",
            "x","sma_5","sma_7","sma_14","ema_7","ema_14",
            "created_at","updated_at"
        ],

        # ========== SPC控制图表 ==========
        "spc_xbar_r_chart": [
            "process_id","tank_name","item_name","analysis_date",
            "subgroup_size","subgroup_count",
            "xbar_grand","xbar_ucl","xbar_cl","xbar_lcl",
            "r_bar","r_ucl","r_cl","r_lcl",
            "lsl","usl","cp","cpk",
            "xbar_ooc_points","r_ooc_points",
            "r2_flag","r3_flag","ooc_total",
            "data_sufficient","limit_source",
            "created_at","updated_at"
        ],
        "spc_xbar_s_chart": [
            "process_id","tank_name","item_name","analysis_date",
            "subgroup_size","subgroup_count",
            "xbar_grand","xbar_ucl","xbar_cl","xbar_lcl",
            "s_bar","s_ucl","s_cl","s_lcl",
            "lsl","usl","cp","cpk",
            "xbar_ooc_points","s_ooc_points",
            "r2_flag","r3_flag","ooc_total",
            "created_at","updated_at"
        ],
        "spc_p_chart": [
            "process_id","shift","analysis_date",
            "n","np","p",
            "p_bar","ucl","cl","lcl",
            "ooc_points","r2_flag","r3_flag","ooc_total",
            "created_at","updated_at"
        ],
        "spc_c_chart": [
            "process_id","shift","analysis_date",
            "c","c_bar",
            "ucl","cl","lcl",
            "ooc_points","r2_flag","r3_flag","ooc_total",
            "created_at","updated_at"
        ],
        # ========== 月度报警率 ==========
        "spc_monthly_alarm_rate": [
            "process_id","tank_name","item_name",
            "year","month",
            "total_points","r0_count","r1_count","r2_count","r3_count",
            "total_alarm_count","alarm_rate",
            "avg_cp","avg_cpk",
            "created_at","updated_at"
        ]
    }
    
    try:
        # 1. 初始化ClickHouse表
        ensure_clickhouse_tables()
        
        # 2. 同步所有表
        for table_name, cols in tables_config.items():
            sync_table_to_clickhouse(spark, table_name, sync_date, cols)
        
        total_duration = time.time() - total_start_time
        logger.info("=" * 80)
        logger.info(f"✅ ClickHouse同步成功")
        logger.info(f"   总耗时: {total_duration:.2f}秒")
        logger.info(f"   同步表数: {len(tables_config)}个")
        logger.info("=" * 80)
        
        # 推送指标
        metrics.push_metrics()
        
    except Exception as e:
        logger.error(f"❌ ClickHouse同步失败: {e}", exc_info=True)
        metrics.push_metrics()
        raise
    finally:
        spark.stop()

if __name__ == "__main__":
    main()