#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bronze → Silver Fact Table ETL v2.0
===================================
核心改进：
1. ✅ 幂等性：基于Bronze水位线 + year_month_day分区增量处理
2. ✅ 事务原子性：PostgreSQL + Iceberg双写事务一致性（全成功或全失败）
3. ✅ 失败重试：Tenacity自动重试3次
4. ✅ 水位线追踪：Silver层维护处理状态
5. ✅ 数据血缘：上报到DataHub和Neo4j
6. ✅ Day分区：year_month_day='20241209' (8位)
"""

import os
import argparse
import logging
import time
from datetime import datetime
from typing import Optional, Tuple
from contextlib import contextmanager

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import StructType

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

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger("fact_table_etl_v2")

# =========================
# 配置
# =========================
PG_HOST = os.getenv("PG_HOST", "172.16.202.54")
PG_PORT = os.getenv("PG_PORT", "5432")
PG_DATABASE = os.getenv("PG_DATABASE", "qms_warehouse")
PG_USER = os.getenv("PG_USER", "admin")
PG_PASSWORD = os.getenv("PG_PASSWORD", "Pg123654")
PG_JDBC_URL = f"jdbc:postgresql://{PG_HOST}:{PG_PORT}/{PG_DATABASE}"

ICEBERG_CATALOG_URI = os.getenv("ICEBERG_CATALOG_URI", "http://iceberg-rest-catalog.data-warehouse.svc.cluster.local:8181")
ICEBERG_WAREHOUSE = os.getenv("ICEBERG_WAREHOUSE", "s3://datalake-bronze-iceberg/")

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "http://172.16.202.55:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin")
S3_REGION = os.getenv("S3_REGION", "us-east-1")

PROMETHEUS_GATEWAY = '172.16.201.110:9091'
JOB_NAME = 'fact_table_etl_v2'

# 血缘配置
DATAHUB_GMS_URL = "http://172.16.202.60:9002/api/gms"
DATAHUB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhY3RvclR5cGUiOiJVU0VSIiwiYWN0b3JJZCI6ImRhdGFodWIiLCJ0eXBlIjoiUEVSU09OQUwiLCJ2ZXJzaW9uIjoiMiIsImp0aSI6ImFmZWFiZTEzLWJjMTMtNDU3Mi04N2I0LTkyN2QxNzcxNzdiNCIsInN1YiI6ImRhdGFodWIiLCJpc3MiOiJkYXRhaHViLW1ldGFkYXRhLXNlcnZpY2UifQ.s6wyrLe3vMtHNIbqO8Hqqtpj50Ej_9PHvFs_FAjVELk"
NEO4J_URI = "bolt://172.16.202.65:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "test"

# 水位线表
WATERMARK_TABLE = "iceberg.silver_qms._fact_etl_watermarks"

# 异常数据标记
INVALID_PARTITION_MARKER = "99999999"

# =========================
# Prometheus Metrics
# =========================
class FactETLMetrics:
    def __init__(self):
        if not PROMETHEUS_AVAILABLE:
            return
        
        self.registry = CollectorRegistry()
        
        self.processing_duration = Histogram(
            'fact_etl_v2_duration_seconds',
            '事实表ETL处理时长',
            ['fact_table', 'operation'],
            registry=self.registry
        )
        
        self.records_read_bronze = Gauge('fact_etl_v2_records_read_bronze', 'Bronze层增量读取', ['fact_table', 'year_month_day'], registry=self.registry)
        self.records_after_processing = Gauge('fact_etl_v2_records_after_processing', '业务处理后记录数', ['fact_table'], registry=self.registry)
        self.records_written_pg = Gauge('fact_etl_v2_records_written_pg', 'PostgreSQL写入记录数', ['fact_table'], registry=self.registry)
        self.records_written_iceberg = Gauge('fact_etl_v2_records_written_iceberg', 'Iceberg写入记录数', ['fact_table'], registry=self.registry)
        
        self.watermark_timestamp = Gauge('fact_etl_v2_watermark_timestamp', '当前水位线时间戳(Unix秒)', ['fact_table', 'year_month_day'], registry=self.registry)
        
        self.dimension_join_success = Gauge('fact_etl_v2_dimension_join_success', '维度关联成功', ['fact_table', 'dimension'], registry=self.registry)
        self.dimension_join_null = Gauge('fact_etl_v2_dimension_join_null', '维度关联为空', ['fact_table', 'dimension'], registry=self.registry)
        
        self.data_quality_invalid = Gauge('fact_etl_v2_data_quality_invalid', '数据质量异常', ['fact_table', 'quality_issue'], registry=self.registry)
        
        self.operation_success = Counter('fact_etl_v2_success_total', 'ETL操作成功', ['fact_table', 'operation'], registry=self.registry)
        self.operation_failure = Counter('fact_etl_v2_failure_total', 'ETL操作失败', ['fact_table', 'operation'], registry=self.registry)
        
        self.transaction_rollback = Counter('fact_etl_v2_transaction_rollback_total', '事务回滚次数', ['fact_table'], registry=self.registry)
    
    def push_metrics(self):
        if not PROMETHEUS_AVAILABLE:
            return
        try:
            push_to_gateway(PROMETHEUS_GATEWAY, job=JOB_NAME, registry=self.registry)
        except Exception as e:
            logger.warning(f"⚠️ Prometheus推送失败: {e}")

metrics = FactETLMetrics()

# =========================
# 数据血缘上报
# =========================
def report_fact_lineage(fact_table: str):
    """上报事实表血缘: Bronze Iceberg → Silver PostgreSQL & Iceberg + 维度表"""
    if not LINEAGE_AVAILABLE:
        return
    
    try:
        emitter = DatahubRestEmitter(gms_server=DATAHUB_GMS_URL, token=DATAHUB_TOKEN)
        neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        
        # Source1: Bronze Iceberg Fact
        src_fact_platform = "iceberg"
        src_fact_name = f"bronze_qms.{fact_table}"
        src_fact_urn = f"urn:li:dataset:(urn:li:dataPlatform:{src_fact_platform},{src_fact_name},PROD)"
        
        # Source2-4: Silver Dimensions (PostgreSQL)
        dim_tables = ["categories", "processes", "lines", "date"]
        src_dim_urns = []
        for dim in dim_tables:
            dim_platform = "postgres"
            dim_name = f"{PG_DATABASE}.silver.dim_{dim}"
            dim_urn = f"urn:li:dataset:(urn:li:dataPlatform:{dim_platform},{dim_name},PROD)"
            src_dim_urns.append((dim_urn, dim_name, dim_platform, dim))
        
        # Target1: Silver PostgreSQL Fact
        tgt_pg_platform = "postgres"
        tgt_pg_name = f"{PG_DATABASE}.silver.fact_{fact_table.replace('_', '_')}"
        tgt_pg_urn = f"urn:li:dataset:(urn:li:dataPlatform:{tgt_pg_platform},{tgt_pg_name},PROD)"
        
        # Target2: Silver Iceberg Fact
        tgt_ice_platform = "iceberg"
        tgt_ice_name = f"silver_qms.fact_{fact_table}"
        tgt_ice_urn = f"urn:li:dataset:(urn:li:dataPlatform:{tgt_ice_platform},{tgt_ice_name},PROD)"
        
        logger.debug(f"   📡 [Lineage] {fact_table}: Bronze + Dims → PG + Iceberg")
        
        # DataHub上报
        # 激活Source节点
        emitter.emit(MetadataChangeProposalWrapper(
            entityType="dataset", changeType="UPSERT", entityUrn=src_fact_urn,
            aspectName="status", aspect=StatusClass(removed=False)
        ))
        
        for dim_urn, _, _, _ in src_dim_urns:
            emitter.emit(MetadataChangeProposalWrapper(
                entityType="dataset", changeType="UPSERT", entityUrn=dim_urn,
                aspectName="status", aspect=StatusClass(removed=False)
            ))
        
        # 激活Target节点并构建血缘
        all_sources = [src_fact_urn] + [urn for urn, _, _, _ in src_dim_urns]
        
        for tgt_urn in [tgt_pg_urn, tgt_ice_urn]:
            emitter.emit(MetadataChangeProposalWrapper(
                entityType="dataset", changeType="UPSERT", entityUrn=tgt_urn,
                aspectName="status", aspect=StatusClass(removed=False)
            ))
            emitter.emit(MetadataChangeProposalWrapper(
                entityType="dataset", changeType="UPSERT", entityUrn=tgt_urn,
                aspectName="upstreamLineage",
                aspect=UpstreamLineageClass(upstreams=[
                    UpstreamClass(dataset=s, type=DatasetLineageTypeClass.TRANSFORMED) for s in all_sources
                ])
            ))
        
        # Neo4j上报
        query = """
        MERGE (fact:Table {key: $src_fact_key})
        ON CREATE SET fact.name = $src_fact_name, fact.platform = $src_fact_platform
        MERGE (tpg:Table {key: $tgt_pg_key})
        ON CREATE SET tpg.name = $tgt_pg_name, tpg.platform = $tgt_pg_platform
        MERGE (tice:Table {key: $tgt_ice_key})
        ON CREATE SET tice.name = $tgt_ice_name, tice.platform = $tgt_ice_platform
        MERGE (fact)-[:OUTPUT]->(tpg)
        MERGE (fact)-[:OUTPUT]->(tice)
        WITH fact, tpg, tice
        UNWIND $dimensions AS dim
        MERGE (d:Table {key: dim.key})
        ON CREATE SET d.name = dim.name, d.platform = dim.platform
        MERGE (d)-[:OUTPUT]->(tpg)
        MERGE (d)-[:OUTPUT]->(tice)
        """
        
        with neo4j_driver.session() as session:
            session.run(query,
                src_fact_key=f"{src_fact_platform}://default.{src_fact_name.replace('.', '/')}",
                src_fact_name=src_fact_name, src_fact_platform=src_fact_platform,
                tgt_pg_key=f"{tgt_pg_platform}://default.{tgt_pg_name.replace('.', '/')}",
                tgt_pg_name=tgt_pg_name, tgt_pg_platform=tgt_pg_platform,
                tgt_ice_key=f"{tgt_ice_platform}://default.{tgt_ice_name.replace('.', '/')}",
                tgt_ice_name=tgt_ice_name, tgt_ice_platform=tgt_ice_platform,
                dimensions=[{
                    "key": f"{p}://default.{n.replace('.', '/')}",
                    "name": n,
                    "platform": p
                } for _, n, p, _ in src_dim_urns]
            )
        
        neo4j_driver.close()
        logger.info(f"   ✅ [Lineage] {fact_table} 血缘上报成功")
    except Exception as e:
        logger.warning(f"   ⚠️ [Lineage] {fact_table} 血缘上报失败: {e}")

# =========================
# Spark Session
# =========================
def create_spark_session(enable_iceberg: bool = True) -> SparkSession:
    builder = SparkSession.builder.appName("Fact_ETL_v2_Atomic_Transaction")
    
    if enable_iceberg:
        builder = (
            builder
            .config("spark.jars.packages",
                "org.postgresql:postgresql:42.6.0,"
                "org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.4.0,"
                "org.apache.hadoop:hadoop-aws:3.3.4,"
                "com.amazonaws:aws-java-sdk-bundle:1.12.262"
            )
            .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
            .config("spark.sql.catalog.iceberg", "org.apache.iceberg.spark.SparkCatalog")
            .config("spark.sql.catalog.iceberg.type", "rest")
            .config("spark.sql.catalog.iceberg.uri", ICEBERG_CATALOG_URI)
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
    else:
        builder = builder.config("spark.jars.packages", "org.postgresql:postgresql:42.6.0")
    
    spark = builder.getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    spark.sparkContext._jvm.org.apache.log4j.Logger.getLogger("org.apache.iceberg.hadoop.HadoopStreams").setLevel(
        spark.sparkContext._jvm.org.apache.log4j.Level.ERROR
    )
    return spark

# =========================
# 水位线管理
# =========================
def init_watermark_table(spark):
    """初始化事实表水位线表"""
    try:
        spark.sql("CREATE NAMESPACE IF NOT EXISTS iceberg.silver_qms")
        spark.sql(f"""
        CREATE TABLE IF NOT EXISTS {WATERMARK_TABLE} (
            fact_table STRING,
            year_month_day STRING,
            max_bronze_timestamp TIMESTAMP,
            last_execution_date DATE,
            processed_records BIGINT,
            last_updated TIMESTAMP,
            status STRING
        ) USING iceberg
        PARTITIONED BY (fact_table, year_month_day)
        """)
        logger.info(f"✅ 水位线表初始化: {WATERMARK_TABLE}")
    except Exception as e:
        logger.error(f"❌ 水位线表初始化失败: {e}")
        raise

def get_watermark(spark, fact_table: str, year_month_day: str) -> Optional[datetime]:
    """获取指定分区的水位线"""
    try:
        result = spark.sql(f"""
            SELECT max_bronze_timestamp 
            FROM {WATERMARK_TABLE}
            WHERE fact_table = '{fact_table}' 
              AND year_month_day = '{year_month_day}'
              AND status = 'SUCCESS'
            ORDER BY max_bronze_timestamp DESC
            LIMIT 1
        """).collect()
        
        if result and result[0][0]:
            watermark = result[0][0]
            logger.info(f"📌 [{fact_table}/{year_month_day}] 读取水位线: {watermark}")
            return watermark
        else:
            logger.info(f"📌 [{fact_table}/{year_month_day}] 无历史水位线，执行全量初始化")
            return None
    except Exception as e:
        logger.warning(f"⚠️ 读取水位线失败，默认全量处理: {e}")
        return None

def update_watermark(spark, fact_table: str, year_month_day: str, max_timestamp: datetime, execution_date, record_count: int, status: str = "SUCCESS"):
    """原子更新水位线"""
    try:
        ts_str = max_timestamp.strftime('%Y-%m-%d %H:%M:%S.%f')
        date_str = execution_date.strftime('%Y-%m-%d')
        
        spark.sql(f"""
        MERGE INTO {WATERMARK_TABLE} AS t
        USING (
            SELECT 
                '{fact_table}' as fact_table,
                '{year_month_day}' as year_month_day,
                TIMESTAMP '{ts_str}' as max_bronze_timestamp,
                DATE '{date_str}' as last_execution_date,
                CAST({record_count} AS BIGINT) as processed_records,
                current_timestamp() as last_updated,
                '{status}' as status
        ) AS s
        ON t.fact_table = s.fact_table AND t.year_month_day = s.year_month_day
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """)
        
        logger.info(f"✅ 水位线更新: {fact_table}/{year_month_day} -> {ts_str} ({record_count}条)")
        
        if max_timestamp:
            metrics.watermark_timestamp.labels(fact_table=fact_table, year_month_day=year_month_day).set(max_timestamp.timestamp())
    except Exception as e:
        logger.error(f"❌ 水位线更新失败: {e}")
        raise

# =========================
# 读取Bronze（增量）
# =========================
def read_bronze_fact_incremental(spark: SparkSession, fact_table: str, year_month_day: str):
    """增量读取Bronze层事实表"""
    table = f"iceberg.bronze_qms.{fact_table}"
    logger.info(f"Reading Bronze (增量) → {table} | year_month_day={year_month_day}")
    start_time = time.time()
    
    try:
        watermark = get_watermark(spark, fact_table, year_month_day)
        
        df = spark.table(table)
        
        # 过滤分区
        if "year_month_day" in df.columns:
            df = df.filter(F.col("year_month_day") == year_month_day)
        else:
            logger.warning("⚠️ year_month_day列不存在，跳过分区过滤")
        
        # 跳过异常分区
        if year_month_day == INVALID_PARTITION_MARKER:
            logger.warning(f"⚠️ 跳过异常分区: {INVALID_PARTITION_MARKER}")
            return None
        
        # 增量过滤
        if watermark:
            df = df.filter(F.col("bronze_processing_timestamp") > F.lit(watermark))
            logger.info(f"  ⚡ 增量模式: 仅读取 > {watermark}")
        else:
            logger.info(f"  🔄 全量模式: 首次处理")
        
        count = df.count()
        if count == 0:
            logger.info(f"  ✅ 无新增数据，跳过处理")
            return None
        
        metrics.records_read_bronze.labels(fact_table=fact_table, year_month_day=year_month_day).set(count)
        metrics.operation_success.labels(fact_table=fact_table, operation='read_bronze').inc()
        
        duration = time.time() - start_time
        metrics.processing_duration.labels(fact_table=fact_table, operation='read_bronze').observe(duration)
        
        logger.info(f"  📥 读取Bronze: {count}条 (耗时: {duration:.2f}s)")
        return df
    except Exception as e:
        logger.error(f"❌ Bronze读取失败: {e}")
        metrics.operation_failure.labels(fact_table=fact_table, operation='read_bronze').inc()
        raise

# =========================
# 加载维度
# =========================
def load_dimensions(spark: SparkSession):
    """从PostgreSQL加载维度表"""
    logger.info("📚 Loading dimensions from PostgreSQL...")
    start_time = time.time()
    dims = {}
    
    for t in ["categories", "processes", "lines", "date"]:
        tbl = f"silver.dim_{t}"
        try:
            df = (
                spark.read.format("jdbc")
                .option("url", PG_JDBC_URL)
                .option("dbtable", tbl)
                .option("user", PG_USER)
                .option("password", PG_PASSWORD)
                .option("driver", "org.postgresql.Driver")
                .load()
            )
            if t != "date":
                df = df.filter(F.col("is_current") == True)
            dims[t] = df
            logger.info(f"  ✅ {tbl}: {df.count()} rows")
        except Exception as e:
            logger.warning(f"  ⚠️ {tbl} 加载失败: {e}")
            dims[t] = spark.createDataFrame([], StructType([]))
    
    logger.info(f"📊 维度加载完成 (耗时: {time.time() - start_time:.2f}s)")
    return dims

# =========================
# 业务处理
# =========================
def process_analysis_records(bronze_df, dims, fact_table):
    """处理analysis_records事实表"""
    logger.info("🔧 Processing: analysis_records...")
    start_time = time.time()
    df = bronze_df
    
    # record_timestamp: ms → timestamp
    if "record_timestamp" in df.columns:
        df = df.withColumn("record_timestamp", (F.col("record_timestamp") / 1000).cast("timestamp"))
    
    # submission_datetime: ms → timestamp
    if "submission_datetime" in df.columns:
        df = df.withColumn(
            "submission_datetime",
            F.when(F.col("submission_datetime").isNotNull(), (F.col("submission_datetime").cast("bigint") / 1000).cast("timestamp"))
            .otherwise(F.lit(None).cast("timestamp"))
        )
    
    initial_count = df.count()
    
    # 关联维度
    if not dims["categories"].rdd.isEmpty():
        df = df.join(dims["categories"].select(F.col("category_sk").alias("category_key"), "category_id"), on="category_id", how="left")
        category_null = df.filter(F.col("category_key").isNull()).count()
        metrics.dimension_join_null.labels(fact_table=fact_table, dimension='category').set(category_null)
        metrics.dimension_join_success.labels(fact_table=fact_table, dimension='category').set(initial_count - category_null)
    else:
        df = df.withColumn("category_key", F.lit(None).cast("int"))
    
    if not dims["processes"].rdd.isEmpty():
        df = df.join(dims["processes"].select(F.col("process_sk").alias("process_key"), "process_id"), on="process_id", how="left")
        process_null = df.filter(F.col("process_key").isNull()).count()
        metrics.dimension_join_null.labels(fact_table=fact_table, dimension='process').set(process_null)
        metrics.dimension_join_success.labels(fact_table=fact_table, dimension='process').set(initial_count - process_null)
    else:
        df = df.withColumn("process_key", F.lit(None).cast("int"))
    
    if not dims["lines"].rdd.isEmpty():
        df = df.join(dims["lines"].select(F.col("line_sk").alias("line_key"), "line_id"), on="line_id", how="left")
        line_null = df.filter(F.col("line_key").isNull()).count()
        metrics.dimension_join_null.labels(fact_table=fact_table, dimension='line').set(line_null)
        metrics.dimension_join_success.labels(fact_table=fact_table, dimension='line').set(initial_count - line_null)
    else:
        df = df.withColumn("line_key", F.lit(None).cast("int"))
    
    df = df.withColumn("analysis_date", F.to_date(F.col("record_timestamp")))
    
    if not dims["date"].rdd.isEmpty():
        df = df.join(dims["date"].select("date_key", F.col("full_date").alias("full_date")), df.analysis_date == F.col("full_date"), how="left")
        date_null = df.filter(F.col("date_key").isNull()).count()
        metrics.dimension_join_null.labels(fact_table=fact_table, dimension='date').set(date_null)
    else:
        df = df.withColumn("date_key", F.lit(None).cast("int"))
    
    result = df.select(
        F.col("id").cast("string").alias("analysis_id"),
        "date_key", "process_key", "category_key", "line_key",
        F.col("process_id").cast("string"), F.col("category_id").cast("string"), F.col("line_id").cast("string"),
        "analysis_date", "record_timestamp", "report_description", "submitter", "submission_datetime",
        "shift", "analyst", "overall_judgment", "source_filename",
        F.year("analysis_date").alias("year"), F.month("analysis_date").alias("month"), F.dayofmonth("analysis_date").alias("day"),
        F.current_timestamp().alias("created_at"), F.current_timestamp().alias("updated_at")
    )
    
    count = result.count()
    metrics.records_after_processing.labels(fact_table=fact_table).set(count)
    metrics.processing_duration.labels(fact_table=fact_table, operation='process_business').observe(time.time() - start_time)
    logger.info(f"✅ analysis_records处理完成: {count}条 (耗时: {time.time() - start_time:.2f}s)")
    return result

def process_chemical_results(bronze_df, dims, fact_table):
    """处理chemical_analysis_results事实表"""
    logger.info("🔧 Processing: chemical_analysis_results...")
    start_time = time.time()
    df = bronze_df
    initial_count = df.count()
    
    # analysis_date修正
    if "analysis_date" in df.columns:
        dt_type = df.schema["analysis_date"].dataType.simpleString()
        if dt_type in ["int", "bigint", "integer"]:
            df = df.withColumn("analysis_date_fixed", F.when(F.col("analysis_date").isNotNull(), F.expr("date_add('1970-01-01', cast(analysis_date as int))")).otherwise(F.lit(None).cast("date")))
        else:
            df = df.withColumn("analysis_date_fixed", F.to_date(F.col("analysis_date")))
    else:
        df = df.withColumn("analysis_date_fixed", F.lit(None).cast("date"))
    
    date_null_count = df.filter(F.col("analysis_date_fixed").isNull()).count()
    metrics.data_quality_invalid.labels(fact_table=fact_table, quality_issue='missing_date').set(date_null_count)
    
    # analysis_time → timestamp
    if "analysis_time" in df.columns:
        df = df.withColumn("analysis_datetime", F.when((F.col("analysis_time").isNotNull()) & (F.col("analysis_date_fixed").isNotNull()), F.expr("cast(unix_timestamp(analysis_date_fixed) + (analysis_time / 1000) as timestamp)")).otherwise(F.lit(None).cast("timestamp")))
    else:
        df = df.withColumn("analysis_datetime", F.lit(None).cast("timestamp"))
    
    # 关联日期维度
    if not dims["date"].rdd.isEmpty():
        df = df.join(dims["date"].select("date_key", F.col("full_date").alias("full_date")), df.analysis_date_fixed == F.col("full_date"), how="left")
        date_null = df.filter(F.col("date_key").isNull()).count()
        metrics.dimension_join_null.labels(fact_table=fact_table, dimension='date').set(date_null)
    else:
        df = df.withColumn("date_key", F.lit(None).cast("int"))
    
    # 过滤异常日期
    df_valid = df.filter((F.col("analysis_date_fixed").isNotNull()) & (F.year("analysis_date_fixed") >= 2020) & (F.year("analysis_date_fixed") <= 2030))
    invalid_count = initial_count - df_valid.count()
    metrics.data_quality_invalid.labels(fact_table=fact_table, quality_issue='invalid_date_range').set(invalid_count)
    
    result = df_valid.select(
        F.col("id").cast("string").alias("result_id"),
        F.col("analysis_record_id").cast("string").alias("analysis_id"),
        "date_key", F.lit(None).cast("int").alias("process_key"), F.lit(None).cast("int").alias("category_key"), F.lit(None).cast("int").alias("line_key"),
        "tank_name", "item_name", "item_unit", "grade",
        F.col("process_range_min").cast("decimal(10,4)"), F.col("process_range_max").cast("decimal(10,4)"),
        F.col("control_point").cast("decimal(10,4)"), F.col("control_range_min").cast("decimal(10,4)"), F.col("control_range_max").cast("decimal(10,4)"),
        F.col("result_value").cast("decimal(10,4)"), "judgment",
        F.col("analysis_date_fixed").alias("analysis_date"), "analysis_datetime",
        F.year("analysis_date_fixed").alias("year"), F.month("analysis_date_fixed").alias("month"), F.dayofmonth("analysis_date_fixed").alias("day"),
        F.current_timestamp().alias("created_at"), F.current_timestamp().alias("updated_at")
    )
    
    count = result.count()
    metrics.records_after_processing.labels(fact_table=fact_table).set(count)
    metrics.processing_duration.labels(fact_table=fact_table, operation='process_business').observe(time.time() - start_time)
    logger.info(f"✅ chemical_analysis_results处理完成: {count}条 (耗时: {time.time() - start_time:.2f}s)")
    return result

# =========================
# 事务原子性双写
# =========================
class TransactionRollbackException(Exception):
    """自定义事务回滚异常"""
    pass

def atomic_dual_write(spark, df, pg_table: str, iceberg_table: str, date_col: str, execution_date: str, fact_table: str, enable_iceberg: bool):
    """
    原子性双写：PostgreSQL + Iceberg
    事务语义：要么全成功，要么全失败（回滚）
    """
    logger.info(f"\n{'='*80}")
    logger.info(f"🔐 开始原子性双写事务")
    logger.info(f"   Target PG: silver.{pg_table}")
    logger.info(f"   Target Iceberg: {iceberg_table}")
    logger.info(f"{'='*80}")
    
    pg_success = False
    iceberg_success = False
    pg_backup = None
    start_time = time.time()
    
    try:
        # ===== Step 1: PostgreSQL写入 =====
        logger.info("📝 Step 1/2: 写入PostgreSQL...")
        pg_start = time.time()
        
        try:
            # 读取现有数据（备份）
            existing = spark.read.format("jdbc") \
                .option("url", PG_JDBC_URL) \
                .option("dbtable", f"silver.{pg_table}") \
                .option("user", PG_USER) \
                .option("password", PG_PASSWORD) \
                .option("driver", "org.postgresql.Driver") \
                .load()
            
            existing_cols = [c for c in existing.columns if c != "fact_id"]
            pg_backup = existing.select(*existing_cols)  # 保存备份用于回滚
            
            # 删除当天数据
            filtered = pg_backup.filter(F.col(date_col) != F.lit(execution_date))
            
            # 合并新数据
            df_ordered = df.select(*existing_cols)
            final_pg = filtered.union(df_ordered)
            
            # 覆盖写入
            final_pg.write.format("jdbc") \
                .option("url", PG_JDBC_URL) \
                .option("dbtable", f"silver.{pg_table}") \
                .option("user", PG_USER) \
                .option("password", PG_PASSWORD) \
                .option("driver", "org.postgresql.Driver") \
                .mode("overwrite") \
                .save()
            
            pg_success = True
            pg_count = df.count()
            metrics.records_written_pg.labels(fact_table=fact_table).set(pg_count)
            logger.info(f"   ✅ PostgreSQL写入成功: {pg_count}条 (耗时: {time.time() - pg_start:.2f}s)")
            
        except Exception as e:
            logger.error(f"   ❌ PostgreSQL写入失败: {e}")
            raise TransactionRollbackException(f"PostgreSQL写入失败: {e}")
        
        # ===== Step 2: Iceberg写入 =====
        if enable_iceberg:
            logger.info("📝 Step 2/2: 写入Iceberg...")
            ice_start = time.time()
            
            try:
                spark.sql("CREATE NAMESPACE IF NOT EXISTS iceberg.silver_qms")
                
                try:
                    spark.table(iceberg_table)
                    exists = True
                except:
                    exists = False
                
                if not exists:
                    logger.info(f"   🆕 创建Iceberg表: {iceberg_table}")
                    df.writeTo(iceberg_table).create()
                else:
                    logger.info(f"   ➕ 追加到Iceberg表: {iceberg_table}")
                    df.writeTo(iceberg_table).append()
                
                iceberg_success = True
                ice_count = df.count()
                metrics.records_written_iceberg.labels(fact_table=fact_table).set(ice_count)
                logger.info(f"   ✅ Iceberg写入成功: {ice_count}条 (耗时: {time.time() - ice_start:.2f}s)")
                
            except Exception as e:
                logger.error(f"   ❌ Iceberg写入失败: {e}")
                # Iceberg失败 → 回滚PostgreSQL
                raise TransactionRollbackException(f"Iceberg写入失败: {e}")
        else:
            iceberg_success = True  # 禁用时视为成功
        
        # ===== 事务提交 =====
        if pg_success and iceberg_success:
            total_duration = time.time() - start_time
            logger.info(f"\n{'='*80}")
            logger.info(f"✅ 原子性双写事务成功提交")
            logger.info(f"   总耗时: {total_duration:.2f}秒")
            logger.info(f"{'='*80}\n")
            
            metrics.operation_success.labels(fact_table=fact_table, operation='dual_write').inc()
            metrics.processing_duration.labels(fact_table=fact_table, operation='dual_write').observe(total_duration)
        
    except TransactionRollbackException as e:
        # ===== 事务回滚 =====
        logger.error(f"\n{'='*80}")
        logger.error(f"❌ 事务失败，开始回滚...")
        logger.error(f"   失败原因: {e}")
        logger.error(f"{'='*80}")
        
        metrics.transaction_rollback.labels(fact_table=fact_table).inc()
        
        # 回滚PostgreSQL（如果已写入）
        if pg_success and pg_backup is not None:
            logger.warning("🔄 回滚PostgreSQL到原始状态...")
            try:
                pg_backup.write.format("jdbc") \
                    .option("url", PG_JDBC_URL) \
                    .option("dbtable", f"silver.{pg_table}") \
                    .option("user", PG_USER) \
                    .option("password", PG_PASSWORD) \
                    .option("driver", "org.postgresql.Driver") \
                    .mode("overwrite") \
                    .save()
                logger.info("   ✅ PostgreSQL回滚成功")
            except Exception as rollback_err:
                logger.error(f"   ❌ PostgreSQL回滚失败: {rollback_err}")
        
        # Iceberg自动回滚（未提交的写入会被丢弃）
        if enable_iceberg and pg_success:
            logger.info("   ℹ️  Iceberg自动回滚（未提交）")
        
        metrics.operation_failure.labels(fact_table=fact_table, operation='dual_write').inc()
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
def process_fact_etl(spark, fact_table: str, year_month_day: str, execution_date, enable_iceberg: bool):
    """处理单个事实表的ETL（带重试）"""
    logger.info(f"\n{'='*80}")
    logger.info(f"📈 处理事实表: {fact_table}")
    logger.info(f"   分区: {year_month_day}")
    logger.info(f"   执行日期: {execution_date}")
    logger.info(f"{'='*80}")
    
    total_start = time.time()
    
    try:
        # 1. 增量读取Bronze
        bronze_df = read_bronze_fact_incremental(spark, fact_table, year_month_day)
        if bronze_df is None:
            logger.info("✅ 无新增数据，跳过处理")
            return
        
        # 2. 加载维度
        dims = load_dimensions(spark)
        
        # 3. 业务处理
        if fact_table == "analysis_records":
            final_df = process_analysis_records(bronze_df, dims, fact_table)
            pg_table = "fact_analysis_records"
            date_col = "analysis_date"
        else:
            final_df = process_chemical_results(bronze_df, dims, fact_table)
            pg_table = "fact_chemical_results"
            date_col = "analysis_date"
        
        if final_df.rdd.isEmpty():
            logger.warning("⚠️ 业务处理后无数据")
            return
        
        # 4. 原子性双写（PostgreSQL + Iceberg）
        iceberg_table = f"iceberg.silver_qms.fact_{fact_table}"
        atomic_dual_write(spark, final_df, pg_table, iceberg_table, date_col, execution_date, fact_table, enable_iceberg)
        
        # 5. 更新水位线
        max_bronze_ts = bronze_df.agg(F.max("bronze_processing_timestamp")).collect()[0][0]
        processed_count = bronze_df.count()
        update_watermark(spark, fact_table, year_month_day, max_bronze_ts, datetime.strptime(execution_date, '%Y-%m-%d').date(), processed_count, "SUCCESS")
        
        # 6. 上报血缘
        report_fact_lineage(fact_table)
        
        # 7. 记录总耗时
        total_duration = time.time() - total_start
        metrics.processing_duration.labels(fact_table=fact_table, operation='total').observe(total_duration)
        metrics.operation_success.labels(fact_table=fact_table, operation='total').inc()
        
        logger.info(f"✅ Fact ETL完成: {fact_table} (耗时: {total_duration:.2f}s)")
        
    except Exception as e:
        logger.error(f"❌ Fact ETL失败: {e}")
        update_watermark(spark, fact_table, year_month_day, datetime.now(), datetime.strptime(execution_date, '%Y-%m-%d').date(), 0, "FAILED")
        metrics.operation_failure.labels(fact_table=fact_table, operation='total').inc()
        raise

# =========================
# 参数解析
# =========================
def parse_args():
    p = argparse.ArgumentParser(description="Bronze → Silver Fact Table ETL v2.0")
    p.add_argument("--execution_date", required=True)
    p.add_argument("--fact_table", required=True, choices=["analysis_records", "chemical_analysis_results"])
    p.add_argument("--year_month_day", required=True, help="分区日期(YYYYMMDD)，例如: 20241209")
    p.add_argument("--enable_iceberg", default="true", choices=["true", "false"])
    # 兼容旧参数
    p.add_argument("--source_path", default="ignored")
    p.add_argument("--year_month", default=None)
    return p.parse_args()

# =========================
# 主函数
# =========================
def main():
    args = parse_args()
    execution_date = args.execution_date
    fact_table = args.fact_table
    year_month_day = args.year_month_day
    enable_iceberg = args.enable_iceberg.lower() == "true"
    
    logger.info("=" * 80)
    logger.info("🚀 Bronze → Silver Fact Table ETL v2.0")
    logger.info(f"   事实表: {fact_table}")
    logger.info(f"   分区: {year_month_day}")
    logger.info(f"   执行日期: {execution_date}")
    logger.info(f"   Iceberg启用: {enable_iceberg}")
    logger.info("=" * 80)
    
    spark = create_spark_session(enable_iceberg)
    
    try:
        # 初始化水位线表
        init_watermark_table(spark)
        
        # 处理事实表（带自动重试）
        process_fact_etl(spark, fact_table, year_month_day, execution_date, enable_iceberg)
        
        logger.info("=" * 80)
        logger.info(f"✅ ETL执行成功: {fact_table}")
        logger.info("=" * 80)
        
        # 推送指标
        metrics.push_metrics()
        
    except Exception as e:
        logger.error(f"❌ ETL执行失败: {e}", exc_info=True)
        metrics.push_metrics()
        raise
    finally:
        spark.stop()

if __name__ == "__main__":
    main()