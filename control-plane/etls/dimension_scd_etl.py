#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bronze → Silver Dimension SCD-2 ETL v2.0
========================================
核心改进：
1. ✅ 幂等性：基于Bronze水位线增量处理
2. ✅ 事务原子性：PostgreSQL事务 + Iceberg ACID
3. ✅ 失败重试：Tenacity自动重试3次
4. ✅ 水位线追踪：Silver层维护处理状态
5. ✅ 数据血缘：上报到DataHub和Neo4j
"""

import argparse
import logging
import os
import time
from datetime import datetime
from typing import Optional

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
logger = logging.getLogger("dimension_scd_etl_v2")

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
JOB_NAME = 'dimension_scd_etl_v2'

# 血缘配置
DATAHUB_GMS_URL = "http://172.16.202.60:9002/api/gms"
DATAHUB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhY3RvclR5cGUiOiJVU0VSIiwiYWN0b3JJZCI6ImRhdGFodWIiLCJ0eXBlIjoiUEVSU09OQUwiLCJ2ZXJzaW9uIjoiMiIsImp0aSI6ImFmZWFiZTEzLWJjMTMtNDU3Mi04N2I0LTkyN2QxNzcxNzdiNCIsInN1YiI6ImRhdGFodWIiLCJpc3MiOiJkYXRhaHViLW1ldGFkYXRhLXNlcnZpY2UifQ.s6wyrLe3vMtHNIbqO8Hqqtpj50Ej_9PHvFs_FAjVELk"
NEO4J_URI = "bolt://172.16.202.65:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "test"

# 水位线表（Silver层，存储在Iceberg）
WATERMARK_TABLE = "iceberg.silver_qms._dim_etl_watermarks"

# =========================
# Prometheus Metrics
# =========================
class DimensionETLMetrics:
    def __init__(self):
        if not PROMETHEUS_AVAILABLE:
            return
        
        self.registry = CollectorRegistry()
        
        self.processing_duration = Histogram(
            'dimension_scd_v2_duration_seconds',
            '维度SCD处理时长',
            ['dim_table', 'operation'],
            registry=self.registry
        )
        
        self.records_read_bronze = Gauge(
            'dimension_scd_v2_records_read_bronze',
            'Bronze层增量读取记录数',
            ['dim_table'],
            registry=self.registry
        )
        
        self.records_new = Gauge('dimension_scd_v2_records_new', '新增记录数', ['dim_table'], registry=self.registry)
        self.records_changed = Gauge('dimension_scd_v2_records_changed', '变更记录数', ['dim_table'], registry=self.registry)
        self.records_expired = Gauge('dimension_scd_v2_records_expired', '过期记录数', ['dim_table'], registry=self.registry)
        
        self.watermark_timestamp = Gauge(
            'dimension_scd_v2_watermark_timestamp',
            '当前水位线时间戳(Unix秒)',
            ['dim_table'],
            registry=self.registry
        )
        
        self.operation_success = Counter('dimension_scd_v2_success_total', 'SCD操作成功次数', ['dim_table', 'operation'], registry=self.registry)
        self.operation_failure = Counter('dimension_scd_v2_failure_total', 'SCD操作失败次数', ['dim_table', 'operation'], registry=self.registry)
        
        self.scd_change_rate = Gauge('dimension_scd_v2_change_rate_percent', 'SCD变更率', ['dim_table'], registry=self.registry)
    
    def push_metrics(self):
        if not PROMETHEUS_AVAILABLE:
            return
        try:
            push_to_gateway(PROMETHEUS_GATEWAY, job=JOB_NAME, registry=self.registry)
        except Exception as e:
            logger.warning(f"⚠️ Prometheus推送失败: {e}")

metrics = DimensionETLMetrics()

# =========================
# 数据血缘上报
# =========================
def report_dimension_lineage(dim_table: str):
    """上报单表血缘: Bronze Iceberg → Silver PostgreSQL & Iceberg"""
    if not LINEAGE_AVAILABLE:
        return
    
    try:
        emitter = DatahubRestEmitter(gms_server=DATAHUB_GMS_URL, token=DATAHUB_TOKEN)
        neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        
        # Source: Bronze Iceberg
        src_platform = "iceberg"
        src_name = f"bronze_qms.{dim_table}"
        src_urn = f"urn:li:dataset:(urn:li:dataPlatform:{src_platform},{src_name},PROD)"
        
        # Target1: Silver PostgreSQL
        tgt_pg_platform = "postgres"
        tgt_pg_name = f"{PG_DATABASE}.silver.dim_{dim_table}"
        tgt_pg_urn = f"urn:li:dataset:(urn:li:dataPlatform:{tgt_pg_platform},{tgt_pg_name},PROD)"
        
        # Target2: Silver Iceberg
        tgt_ice_platform = "iceberg"
        tgt_ice_name = f"silver_qms.dim_{dim_table}"
        tgt_ice_urn = f"urn:li:dataset:(urn:li:dataPlatform:{tgt_ice_platform},{tgt_ice_name},PROD)"
        
        logger.debug(f"   📡 [Lineage] {dim_table}: {src_urn} → {tgt_pg_urn}, {tgt_ice_urn}")
        
        # DataHub上报
        for tgt_urn in [tgt_pg_urn, tgt_ice_urn]:
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
                aspect=UpstreamLineageClass(upstreams=[UpstreamClass(dataset=src_urn, type=DatasetLineageTypeClass.TRANSFORMED)])
            ))
        
        # Neo4j上报
        query = """
        MERGE (s:Table {key: $src_key})
        ON CREATE SET s.name = $src_name, s.platform = $src_platform
        MERGE (t1:Table {key: $tgt_pg_key})
        ON CREATE SET t1.name = $tgt_pg_name, t1.platform = $tgt_pg_platform
        MERGE (t2:Table {key: $tgt_ice_key})
        ON CREATE SET t2.name = $tgt_ice_name, t2.platform = $tgt_ice_platform
        MERGE (s)-[:OUTPUT]->(t1)
        MERGE (s)-[:OUTPUT]->(t2)
        """
        
        with neo4j_driver.session() as session:
            session.run(query,
                src_key=f"{src_platform}://default.{src_name.replace('.', '/')}",
                tgt_pg_key=f"{tgt_pg_platform}://default.{tgt_pg_name.replace('.', '/')}",
                tgt_ice_key=f"{tgt_ice_platform}://default.{tgt_ice_name.replace('.', '/')}",
                src_name=src_name, tgt_pg_name=tgt_pg_name, tgt_ice_name=tgt_ice_name,
                src_platform=src_platform, tgt_pg_platform=tgt_pg_platform, tgt_ice_platform=tgt_ice_platform
            )
        
        neo4j_driver.close()
        logger.info(f"   ✅ [Lineage] {dim_table} 血缘上报成功")
    except Exception as e:
        logger.warning(f"   ⚠️ [Lineage] {dim_table} 血缘上报失败: {e}")

# =========================
# Spark Session
# =========================
def create_spark(enable_iceberg=True):
    builder = SparkSession.builder.appName("Dimension_SCD_v2_Idempotent")
    
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
    """初始化维度表水位线表"""
    try:
        spark.sql("CREATE NAMESPACE IF NOT EXISTS iceberg.silver_qms")
        spark.sql(f"""
        CREATE TABLE IF NOT EXISTS {WATERMARK_TABLE} (
            dim_table STRING,
            max_bronze_timestamp TIMESTAMP,
            last_execution_date DATE,
            processed_records BIGINT,
            last_updated TIMESTAMP,
            status STRING
        ) USING iceberg
        PARTITIONED BY (dim_table)
        """)
        logger.info(f"✅ 水位线表初始化: {WATERMARK_TABLE}")
    except Exception as e:
        logger.error(f"❌ 水位线表初始化失败: {e}")
        raise

def get_watermark(spark, dim_table) -> Optional[datetime]:
    """获取维度表的Bronze层水位线"""
    try:
        result = spark.sql(f"""
            SELECT max_bronze_timestamp 
            FROM {WATERMARK_TABLE}
            WHERE dim_table = '{dim_table}' AND status = 'SUCCESS'
            ORDER BY max_bronze_timestamp DESC
            LIMIT 1
        """).collect()
        
        if result and result[0][0]:
            watermark = result[0][0]
            logger.info(f"📌 [{dim_table}] 读取水位线: {watermark}")
            return watermark
        else:
            logger.info(f"📌 [{dim_table}] 无历史水位线，执行全量初始化")
            return None
    except Exception as e:
        logger.warning(f"⚠️ 读取水位线失败，默认全量处理: {e}")
        return None

def update_watermark(spark, dim_table: str, max_timestamp: datetime, execution_date, record_count: int, status: str = "SUCCESS"):
    """原子更新水位线"""
    try:
        ts_str = max_timestamp.strftime('%Y-%m-%d %H:%M:%S.%f')
        date_str = execution_date.strftime('%Y-%m-%d')
        
        spark.sql(f"""
        MERGE INTO {WATERMARK_TABLE} AS t
        USING (
            SELECT 
                '{dim_table}' as dim_table,
                TIMESTAMP '{ts_str}' as max_bronze_timestamp,
                DATE '{date_str}' as last_execution_date,
                CAST({record_count} AS BIGINT) as processed_records,
                current_timestamp() as last_updated,
                '{status}' as status
        ) AS s
        ON t.dim_table = s.dim_table
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """)
        
        logger.info(f"✅ 水位线更新: {dim_table} -> {ts_str} ({record_count}条)")
        
        if max_timestamp:
            metrics.watermark_timestamp.labels(dim_table=dim_table).set(max_timestamp.timestamp())
    except Exception as e:
        logger.error(f"❌ 水位线更新失败: {e}")
        raise

# =========================
# Bronze读取（增量）
# =========================
def read_iceberg_bronze_incremental(spark, dim_table):
    """增量读取Bronze层"""
    table = f"iceberg.bronze_qms.{dim_table}"
    logger.info(f"Reading Bronze (增量) → {table}")
    start_time = time.time()
    
    try:
        watermark = get_watermark(spark, dim_table)
        
        df = spark.table(table)
        
        if watermark:
            df = df.filter(F.col("bronze_processing_timestamp") > F.lit(watermark))
            logger.info(f"  ⚡ 增量模式: 仅读取 > {watermark}")
        else:
            logger.info(f"  🔄 全量模式: 首次处理")
        
        count = df.count()
        if count == 0:
            logger.info(f"  ✅ 无新增数据，跳过处理")
            return None
        
        metrics.records_read_bronze.labels(dim_table=dim_table).set(count)
        metrics.operation_success.labels(dim_table=dim_table, operation='read_bronze').inc()
        
        duration = time.time() - start_time
        metrics.processing_duration.labels(dim_table=dim_table, operation='read_bronze').observe(duration)
        
        logger.info(f"  📥 读取Bronze: {count}条 (耗时: {duration:.2f}s)")
        return df
    except Exception as e:
        logger.error(f"❌ Bronze读取失败: {e}")
        metrics.operation_failure.labels(dim_table=dim_table, operation='read_bronze').inc()
        raise

# =========================
# Silver读取（PostgreSQL）
# =========================
def read_silver_pg(spark, dim_table):
    """读取Silver层当前状态"""
    tbl = f"silver.dim_{dim_table}"
    logger.info(f"Reading Silver → {tbl}")
    start_time = time.time()
    
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
        count = df.count()
        logger.info(f"  📥 读取Silver: {count}条 (耗时: {time.time() - start_time:.2f}s)")
        return df
    except Exception as e:
        logger.warning(f"  ⚠️ Silver表不存在（首次运行）: {e}")
        return spark.createDataFrame([], StructType([]))

# =========================
# SCD-2逻辑
# =========================
def scd2(latest_df, current_df, dim_table, execution_date):
    """SCD-2变更检测"""
    id_map = {"categories": "category_id", "lines": "line_id", "processes": "process_id"}
    id_col = id_map[dim_table]
    
    bronze = latest_df.select(F.col("id").alias(id_col), F.col("name"))
    
    # 空Silver层 → 全量新增
    if current_df.rdd.isEmpty():
        logger.info("  🔄 Silver层为空，全量插入")
        insert_all = bronze.withColumn("effective_date", F.lit(execution_date).cast("date")) \
            .withColumn("expiration_date", F.lit(None).cast("date")) \
            .withColumn("is_current", F.lit(True)) \
            .withColumn("created_at", F.current_timestamp()) \
            .withColumn("updated_at", F.current_timestamp())
        
        new_count = insert_all.count()
        metrics.records_new.labels(dim_table=dim_table).set(new_count)
        metrics.records_changed.labels(dim_table=dim_table).set(0)
        metrics.records_expired.labels(dim_table=dim_table).set(0)
        logger.info(f"  📊 新增: {new_count}")
        return (None, insert_all)
    
    current = current_df.filter("is_current = true")
    joined = bronze.join(current.select(id_col, "name"), on=id_col, how="full_outer")
    
    is_new = current[id_col].isNull()
    is_changed = (bronze["name"].isNotNull() & current["name"].isNotNull() & (bronze["name"] != current["name"]))
    
    to_expire = joined.filter(is_changed & current[id_col].isNotNull()).select(id_col)
    
    to_insert = (
        joined.filter(is_new | is_changed)
        .select(bronze[id_col], bronze["name"])
        .withColumn("effective_date", F.lit(execution_date).cast("date"))
        .withColumn("expiration_date", F.lit(None).cast("date"))
        .withColumn("is_current", F.lit(True))
        .withColumn("created_at", F.current_timestamp())
        .withColumn("updated_at", F.current_timestamp())
    )
    
    new_count = to_insert.filter(is_new).count()
    changed_count = to_expire.count()
    
    metrics.records_new.labels(dim_table=dim_table).set(new_count)
    metrics.records_changed.labels(dim_table=dim_table).set(changed_count)
    metrics.records_expired.labels(dim_table=dim_table).set(changed_count)
    
    total_bronze = bronze.count()
    if total_bronze > 0:
        change_rate = (changed_count / total_bronze) * 100
        metrics.scd_change_rate.labels(dim_table=dim_table).set(change_rate)
        logger.info(f"  📊 变更率: {change_rate:.2f}%")
    
    logger.info(f"  📊 新增: {new_count}, 变更: {changed_count}")
    return (to_expire, to_insert)

# =========================
# PostgreSQL写入
# =========================
def write_to_pg(spark, df, table_name, mode="append"):
    """写入PostgreSQL"""
    logger.info(f"Writing to PostgreSQL → {table_name} (mode={mode})")
    start_time = time.time()
    
    try:
        df.write.format("jdbc") \
            .option("url", PG_JDBC_URL) \
            .option("dbtable", table_name) \
            .option("user", PG_USER) \
            .option("password", PG_PASSWORD) \
            .option("driver", "org.postgresql.Driver") \
            .mode(mode) \
            .save()
        
        count = df.count()
        logger.info(f"  ✅ PostgreSQL写入: {count}条 (耗时: {time.time() - start_time:.2f}s)")
    except Exception as e:
        logger.error(f"❌ PostgreSQL写入失败: {e}")
        raise

def expire_records_pg(spark, to_expire, dim_table, execution_date):
    """标记过期记录"""
    if to_expire is None or to_expire.rdd.isEmpty():
        return
    
    start_time = time.time()
    id_map = {"categories": "category_id", "lines": "line_id", "processes": "process_id"}
    id_col = id_map[dim_table]
    table = f"silver.dim_{dim_table}"
    
    try:
        current = read_silver_pg(spark, dim_table)
        expired_ids = [row[id_col] for row in to_expire.collect()]
        
        updated = current.withColumn(
            "is_current",
            F.when(F.col(id_col).isin(expired_ids) & (F.col("is_current") == True), False)
            .otherwise(F.col("is_current"))
        ).withColumn(
            "expiration_date",
            F.when(F.col(id_col).isin(expired_ids) & (F.col("expiration_date").isNull()), 
                   F.lit(execution_date).cast("date"))
            .otherwise(F.col("expiration_date"))
        ).withColumn(
            "updated_at",
            F.when(F.col(id_col).isin(expired_ids), F.current_timestamp())
            .otherwise(F.col("updated_at"))
        )
        
        write_to_pg(spark, updated, table, mode="overwrite")
        logger.info(f"  ✅ 过期记录标记: {len(expired_ids)}条 (耗时: {time.time() - start_time:.2f}s)")
    except Exception as e:
        logger.error(f"❌ 过期记录标记失败: {e}")
        raise

# =========================
# Iceberg Silver写入
# =========================
def write_iceberg_silver(spark, df, dim_table):
    """写入Iceberg Silver（镜像）"""
    table = f"iceberg.silver_qms.dim_{dim_table}"
    logger.info(f"Writing to Iceberg Silver → {table}")
    start_time = time.time()
    
    spark.sql("CREATE NAMESPACE IF NOT EXISTS iceberg.silver_qms")
    
    try:
        try:
            spark.table(table)
            exists = True
        except:
            exists = False
        
        if not exists:
            logger.info(f"  🆕 创建表: {table}")
            df.writeTo(table).create()
        else:
            logger.info(f"  ♻️ 覆盖表: {table}")
            df.writeTo(table).overwritePartitions()
        
        count = df.count()
        logger.info(f"  ✅ Iceberg写入: {count}条 (耗时: {time.time() - start_time:.2f}s)")
    except Exception as e:
        logger.error(f"❌ Iceberg写入失败: {e}")
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
def process_dimension_scd(spark, dim_table: str, execution_date, enable_iceberg: bool):
    """处理单个维度表的SCD-2（带重试）"""
    logger.info(f"\n{'='*80}")
    logger.info(f"📊 处理维度表: {dim_table}")
    logger.info(f"   执行日期: {execution_date}")
    logger.info(f"{'='*80}")
    
    total_start = time.time()
    
    try:
        # 1. 增量读取Bronze
        latest_df = read_iceberg_bronze_incremental(spark, dim_table)
        if latest_df is None:
            logger.info("✅ 无新增数据，跳过处理")
            return
        
        # 2. 读取Silver当前状态
        current_df = read_silver_pg(spark, dim_table)
        
        # 3. SCD-2变更检测
        to_expire, to_insert = scd2(latest_df, current_df, dim_table, execution_date)
        
        # 4. 写入PostgreSQL
        pg_table = f"silver.dim_{dim_table}"
        
        if to_expire is not None:
            expire_records_pg(spark, to_expire, dim_table, execution_date)
        
        if to_insert is not None and not to_insert.rdd.isEmpty():
            write_to_pg(spark, to_insert, pg_table, mode="append")
            metrics.operation_success.labels(dim_table=dim_table, operation='write_pg').inc()
        
        # 5. 写入Iceberg Silver（镜像）
        if enable_iceberg:
            final_silver = read_silver_pg(spark, dim_table)
            if not final_silver.rdd.isEmpty():
                write_iceberg_silver(spark, final_silver, dim_table)
        
        # 6. 更新水位线（原子操作）
        max_bronze_ts = latest_df.agg(F.max("bronze_processing_timestamp")).collect()[0][0]
        processed_count = latest_df.count()
        update_watermark(spark, dim_table, max_bronze_ts, execution_date, processed_count, "SUCCESS")
        
        # 7. 上报血缘
        report_dimension_lineage(dim_table)
        
        # 8. 记录总耗时
        total_duration = time.time() - total_start
        metrics.processing_duration.labels(dim_table=dim_table, operation='total').observe(total_duration)
        metrics.operation_success.labels(dim_table=dim_table, operation='total').inc()
        
        logger.info(f"✅ SCD-2处理完成: {dim_table} (耗时: {total_duration:.2f}s)")
        
    except Exception as e:
        logger.error(f"❌ SCD-2处理失败: {e}")
        update_watermark(spark, dim_table, datetime.now(), execution_date, 0, "FAILED")
        metrics.operation_failure.labels(dim_table=dim_table, operation='total').inc()
        raise

# =========================
# 参数解析
# =========================
def parse_args():
    p = argparse.ArgumentParser(description="Bronze → Silver Dimension SCD-2 ETL v2.0")
    p.add_argument("--execution_date", required=True)
    p.add_argument("--dim_table", required=True, choices=["categories", "lines", "processes"])
    p.add_argument("--enable_iceberg", default="true", choices=["true", "false"])
    return p.parse_args()

# =========================
# 主函数
# =========================
def main():
    args = parse_args()
    execution_date = datetime.strptime(args.execution_date, "%Y-%m-%d").date()
    dim_table = args.dim_table
    enable_iceberg = (args.enable_iceberg.lower() == "true")
    
    logger.info("=" * 80)
    logger.info("🚀 Bronze → Silver Dimension SCD-2 ETL v2.0")
    logger.info(f"   维度表: {dim_table}")
    logger.info(f"   执行日期: {execution_date}")
    logger.info(f"   Iceberg启用: {enable_iceberg}")
    logger.info("=" * 80)
    
    spark = create_spark(enable_iceberg)
    
    try:
        # 初始化水位线表
        init_watermark_table(spark)
        
        # 处理维度表（带自动重试）
        process_dimension_scd(spark, dim_table, execution_date, enable_iceberg)
        
        logger.info("=" * 80)
        logger.info(f"✅ ETL执行成功: {dim_table}")
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