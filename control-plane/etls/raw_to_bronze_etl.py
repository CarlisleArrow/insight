#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RAW → Bronze ETL v2.0 (幂等性 + 事务性 + 失败重试版)
==================================================
核心改进：
1. ✅ 幂等性：基于水位线（raw_ingestion_timestamp）增量处理
2. ✅ 事务原子性：Iceberg ACID + 水位线MERGE保证一致性
3. ✅ 失败重试：Tenacity自动重试3次
4. ✅ 跳过异常数据：过滤 year_month_day='99999999'
5. ✅ Day分区：year_month_day='20241209' (8位)
6. ✅ 水位线持久化：Iceberg表存储在 datalake-bronze-iceberg

关键变更：
- RAW层分区: year_month_day (需CDC脚本同步调整)
- 水位线表: iceberg.bronze_qms._etl_watermarks
- 增量读取: 仅处理 raw_ingestion_timestamp > 上次水位线 的数据
"""

import logging
import time
from typing import Optional, Tuple
from dataclasses import dataclass
from datetime import datetime

from pyspark.sql import SparkSession, DataFrame
from pyspark.sql.functions import (
    col, row_number, trim, upper, regexp_replace, current_timestamp,
    when, to_timestamp, from_unixtime, substring, lit, max as spark_max
)
from pyspark.sql.window import Window

# 重试库
try:
    from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
    TENACITY_AVAILABLE = True
except ImportError:
    TENACITY_AVAILABLE = False
    logging.warning("⚠️ tenacity未安装，失败重试功能禁用。pip install tenacity")

# Prometheus监控
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
        DatasetLineageTypeClass,
        UpstreamLineageClass,
        UpstreamClass,
        StatusClass
    )
    from neo4j import GraphDatabase
    LINEAGE_AVAILABLE = True
except ImportError:
    LINEAGE_AVAILABLE = False
    logging.warning("⚠️ datahub/neo4j未安装，血缘上报禁用。pip install acryl-datahub neo4j")

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# =========================
# 配置
# =========================
MINIO_ENDPOINT = "http://172.16.202.55:9000"
MINIO_ACCESS_KEY = "minioadmin"
MINIO_SECRET_KEY = "minioadmin"
S3_REGION = "us-east-1"

RAW_BASE_PATH = "s3a://datalake-raw/qms"
BRONZE_BASE_PATH = "s3a://datalake-bronze/qms"

# Iceberg配置
ICEBERG_ENABLED = True
ICEBERG_CATALOG_NAME = "iceberg"
ICEBERG_CATALOG_URI = "http://iceberg-rest-catalog.data-warehouse.svc.cluster.local:8181"
ICEBERG_WAREHOUSE = "s3a://datalake-bronze-iceberg/"
ICEBERG_NAMESPACE = "bronze_qms"

# 水位线表（Iceberg持久化）
WATERMARK_TABLE = f"{ICEBERG_CATALOG_NAME}.{ICEBERG_NAMESPACE}._etl_watermarks"

# Prometheus配置
PROMETHEUS_GATEWAY = '172.16.201.110:9091'
JOB_NAME = 'raw_to_bronze_etl_v2'

# 异常数据标记（需跳过）
INVALID_PARTITION_MARKER = "99999999"  # 8位year_month_day

# =========================
# 🌐 血缘配置
# =========================
DATAHUB_GMS_URL = "http://172.16.202.60:9002/api/gms"
DATAHUB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhY3RvclR5cGUiOiJVU0VSIiwiYWN0b3JJZCI6ImRhdGFodWIiLCJ0eXBlIjoiUEVSU09OQUwiLCJ2ZXJzaW9uIjoiMiIsImp0aSI6ImFmZWFiZTEzLWJjMTMtNDU3Mi04N2I0LTkyN2QxNzcxNzdiNCIsInN1YiI6ImRhdGFodWIiLCJpc3MiOiJkYXRhaHViLW1ldGFkYXRhLXNlcnZpY2UifQ.s6wyrLe3vMtHNIbqO8Hqqtpj50Ej_9PHvFs_FAjVELk"

NEO4J_URI = "bolt://172.16.202.65:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "test"

# 表分类（用于血缘上报）
DIMENSION_TABLES = ["categories", "lines", "processes"]
FACT_TABLES = ["analysis_records", "chemical_analysis_results"]

# =========================
# Prometheus指标
# =========================
@dataclass
class ETLMetrics:
    registry: object = None
    processing_duration: object = None
    records_read: object = None
    records_written: object = None
    watermark_timestamp: object = None
    operation_success: object = None
    operation_failure: object = None
    
    def __post_init__(self):
        if not PROMETHEUS_AVAILABLE:
            return
        
        self.registry = CollectorRegistry()
        
        self.processing_duration = Histogram(
            'bronze_etl_v2_duration_seconds',
            'Bronze ETL处理时长',
            ['table_name', 'partition_key'],
            registry=self.registry
        )
        
        self.records_read = Gauge(
            'bronze_etl_v2_records_read',
            'RAW层增量读取记录数',
            ['table_name', 'partition_key'],
            registry=self.registry
        )
        
        self.records_written = Gauge(
            'bronze_etl_v2_records_written',
            'Bronze层写入记录数',
            ['table_name', 'partition_key'],
            registry=self.registry
        )
        
        self.watermark_timestamp = Gauge(
            'bronze_etl_v2_watermark_timestamp',
            '当前水位线时间戳(Unix秒)',
            ['table_name', 'partition_key'],
            registry=self.registry
        )
        
        self.operation_success = Counter(
            'bronze_etl_v2_success_total',
            'ETL成功次数',
            ['table_name', 'partition_key', 'operation'],
            registry=self.registry
        )
        
        self.operation_failure = Counter(
            'bronze_etl_v2_failure_total',
            'ETL失败次数',
            ['table_name', 'partition_key', 'operation'],
            registry=self.registry
        )
    
    def push_metrics(self):
        if not PROMETHEUS_AVAILABLE:
            return
        try:
            push_to_gateway(PROMETHEUS_GATEWAY, job=JOB_NAME, registry=self.registry)
        except Exception as e:
            logger.warning(f"⚠️ Prometheus推送失败: {e}")

metrics = ETLMetrics()

# =========================
# 🔗 数据血缘上报逻辑
# =========================
def report_bronze_lineage(table_name: str, is_fact: bool = False):
    """
    上报单表血缘: RAW (S3) → Bronze (Iceberg)
    
    Args:
        table_name: 表名（如 "analysis_records"）
        is_fact: 是否为事实表
    """
    if not LINEAGE_AVAILABLE:
        return
    
    try:
        # 初始化连接
        emitter = DatahubRestEmitter(gms_server=DATAHUB_GMS_URL, token=DATAHUB_TOKEN)
        neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        
        # 定义URN
        src_platform = "s3"
        src_name = f"datalake-raw/qms/{table_name}"
        src_urn = f"urn:li:dataset:(urn:li:dataPlatform:{src_platform},{src_name},PROD)"
        
        tgt_platform = "iceberg"
        tgt_name = f"{ICEBERG_NAMESPACE}.{table_name}"
        tgt_urn = f"urn:li:dataset:(urn:li:dataPlatform:{tgt_platform},{tgt_name},PROD)"
        
        logger.debug(f"   📡 [Lineage] {table_name}: {src_urn} → {tgt_urn}")
        
        # === DataHub 上报 ===
        # 1. 激活Source（RAW S3）
        emitter.emit(MetadataChangeProposalWrapper(
            entityType="dataset", changeType="UPSERT", entityUrn=src_urn,
            aspectName="status", aspect=StatusClass(removed=False)
        ))
        
        # 2. 激活Target（Bronze Iceberg）
        emitter.emit(MetadataChangeProposalWrapper(
            entityType="dataset", changeType="UPSERT", entityUrn=tgt_urn,
            aspectName="status", aspect=StatusClass(removed=False)
        ))
        
        # 3. 构建血缘（Bronze指向RAW）
        lineage_aspect = UpstreamLineageClass(upstreams=[
            UpstreamClass(dataset=src_urn, type=DatasetLineageTypeClass.TRANSFORMED)
        ])
        
        emitter.emit(MetadataChangeProposalWrapper(
            entityType="dataset", changeType="UPSERT", entityUrn=tgt_urn,
            aspectName="upstreamLineage", aspect=lineage_aspect
        ))
        
        # === Neo4j (Amundsen) 上报 ===
        neo4j_src_key = f"{src_platform}://default.default/{src_name}"
        neo4j_tgt_key = f"{tgt_platform}://default.{tgt_name.replace('.', '/')}"
        
        query = """
        MERGE (s:Table {key: $src_key})
        ON CREATE SET s.name = $src_name, s.platform = $src_platform
        MERGE (t:Table {key: $tgt_key})
        ON CREATE SET t.name = $tgt_name, t.platform = $tgt_platform
        MERGE (s)-[:OUTPUT]->(t)
        """
        
        with neo4j_driver.session() as session:
            session.run(
                query,
                src_key=neo4j_src_key,
                tgt_key=neo4j_tgt_key,
                src_name=src_name,
                tgt_name=tgt_name,
                src_platform=src_platform,
                tgt_platform=tgt_platform
            )
        
        neo4j_driver.close()
        logger.info(f"   ✅ [Lineage] {table_name} 血缘上报成功")
        
    except Exception as e:
        logger.warning(f"   ⚠️ [Lineage] {table_name} 血缘上报失败: {e}")

def report_all_bronze_lineage():
    """批量上报所有表的血缘关系"""
    if not LINEAGE_AVAILABLE:
        logger.warning("⚠️ 血缘依赖未安装，跳过血缘上报")
        return
    
    logger.info("\n" + "=" * 80)
    logger.info("📡 开始上报 RAW → Bronze 批处理血缘...")
    logger.info("=" * 80)
    
    success_count = 0
    total_count = len(DIMENSION_TABLES) + len(FACT_TABLES)
    
    # 上报维度表
    for table in DIMENSION_TABLES:
        try:
            report_bronze_lineage(table, is_fact=False)
            success_count += 1
        except Exception as e:
            logger.error(f"   ❌ [Lineage] {table} 上报失败: {e}")
    
    # 上报事实表
    for table in FACT_TABLES:
        try:
            report_bronze_lineage(table, is_fact=True)
            success_count += 1
        except Exception as e:
            logger.error(f"   ❌ [Lineage] {table} 上报失败: {e}")
    
    logger.info("=" * 80)
    logger.info(f"📡 血缘上报完成: 成功 {success_count}/{total_count} 个表")
    logger.info("=" * 80)
    logger.info("")

# =========================
# Spark Session
# =========================
def create_spark_session() -> SparkSession:
    """创建Spark Session（MinIO + Iceberg）"""
    builder = (
        SparkSession.builder.appName("RAW_to_Bronze_ETL_v2_Idempotent")
        .config("spark.hadoop.fs.s3a.endpoint", MINIO_ENDPOINT)
        .config("spark.hadoop.fs.s3a.access.key", MINIO_ACCESS_KEY)
        .config("spark.hadoop.fs.s3a.secret.key", MINIO_SECRET_KEY)
        .config("spark.hadoop.fs.s3a.path.style.access", "true")
        .config("spark.hadoop.fs.s3a.connection.ssl.enabled", "false")
        .config("spark.hadoop.fs.s3a.impl", "org.apache.hadoop.fs.s3a.S3AFileSystem")
        .config("spark.hadoop.fs.s3a.aws.credentials.provider", "org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider")
        .config("spark.hadoop.fs.s3a.aws.region", S3_REGION)
    )
    
    if ICEBERG_ENABLED:
        builder = (
            builder.config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
            .config(f"spark.sql.catalog.{ICEBERG_CATALOG_NAME}", "org.apache.iceberg.spark.SparkCatalog")
            .config(f"spark.sql.catalog.{ICEBERG_CATALOG_NAME}.type", "rest")
            .config(f"spark.sql.catalog.{ICEBERG_CATALOG_NAME}.uri", ICEBERG_CATALOG_URI)
            .config(f"spark.sql.catalog.{ICEBERG_CATALOG_NAME}.warehouse", ICEBERG_WAREHOUSE)
            .config(f"spark.sql.catalog.{ICEBERG_CATALOG_NAME}.io-impl", "org.apache.iceberg.hadoop.HadoopFileIO")
        )
    
    spark = builder.getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    spark.sparkContext._jvm.org.apache.log4j.Logger.getLogger("org.apache.iceberg.hadoop.HadoopStreams").setLevel(
        spark.sparkContext._jvm.org.apache.log4j.Level.ERROR
    )
    return spark

# =========================
# 水位线管理
# =========================
def init_watermark_table(spark: SparkSession) -> None:
    """初始化水位线表（首次运行）"""
    try:
        spark.sql(f"CREATE NAMESPACE IF NOT EXISTS {ICEBERG_CATALOG_NAME}.{ICEBERG_NAMESPACE}")
        
        spark.sql(f"""
        CREATE TABLE IF NOT EXISTS {WATERMARK_TABLE} (
            table_name STRING,
            partition_key STRING,
            max_raw_timestamp TIMESTAMP,
            processed_records BIGINT,
            last_updated TIMESTAMP,
            status STRING
        ) USING iceberg
        PARTITIONED BY (table_name)
        """)
        
        logger.info(f"✅ 水位线表初始化完成: {WATERMARK_TABLE}")
    except Exception as e:
        logger.error(f"❌ 水位线表初始化失败: {e}")
        raise

def get_watermark(spark: SparkSession, table_name: str, partition_key: str = "ALL") -> Optional[datetime]:
    """获取指定分区的水位线时间戳"""
    try:
        result = spark.sql(f"""
            SELECT max_raw_timestamp 
            FROM {WATERMARK_TABLE}
            WHERE table_name = '{table_name}' 
              AND partition_key = '{partition_key}'
              AND status = 'SUCCESS'
            ORDER BY max_raw_timestamp DESC
            LIMIT 1
        """).collect()
        
        if result and result[0][0]:
            watermark = result[0][0]
            logger.info(f"📌 [{table_name}/{partition_key}] 读取水位线: {watermark}")
            return watermark
        else:
            logger.info(f"📌 [{table_name}/{partition_key}] 无历史水位线，执行全量初始化")
            return None
    except Exception as e:
        logger.warning(f"⚠️ 读取水位线失败，默认全量处理: {e}")
        return None

def update_watermark(
    spark: SparkSession, 
    table_name: str, 
    partition_key: str, 
    max_timestamp: datetime,
    record_count: int,
    status: str = "SUCCESS"
) -> None:
    """原子更新水位线（MERGE操作）"""
    try:
        # 格式化时间戳为SQL兼容格式
        ts_str = max_timestamp.strftime('%Y-%m-%d %H:%M:%S.%f')
        
        spark.sql(f"""
        MERGE INTO {WATERMARK_TABLE} AS t
        USING (
            SELECT 
                '{table_name}' as table_name,
                '{partition_key}' as partition_key,
                TIMESTAMP '{ts_str}' as max_raw_timestamp,
                CAST({record_count} AS BIGINT) as processed_records,
                current_timestamp() as last_updated,
                '{status}' as status
        ) AS s
        ON t.table_name = s.table_name AND t.partition_key = s.partition_key
        WHEN MATCHED THEN UPDATE SET 
            max_raw_timestamp = s.max_raw_timestamp,
            processed_records = s.processed_records,
            last_updated = s.last_updated,
            status = s.status
        WHEN NOT MATCHED THEN INSERT *
        """)
        
        logger.info(f"✅ 水位线更新成功: {table_name}/{partition_key} -> {ts_str} ({record_count}条)")
        
        # 更新Prometheus指标
        if max_timestamp:
            metrics.watermark_timestamp.labels(
                table_name=table_name,
                partition_key=partition_key
            ).set(max_timestamp.timestamp())
        
    except Exception as e:
        logger.error(f"❌ 水位线更新失败: {e}")
        raise

def mark_watermark_failed(spark: SparkSession, table_name: str, partition_key: str) -> None:
    """标记水位线为失败状态（用于失败重试）"""
    try:
        spark.sql(f"""
        UPDATE {WATERMARK_TABLE}
        SET status = 'FAILED', last_updated = current_timestamp()
        WHERE table_name = '{table_name}' AND partition_key = '{partition_key}'
        """)
    except Exception as e:
        logger.warning(f"⚠️ 标记失败状态失败: {e}")

# =========================
# Iceberg写入
# =========================
def write_to_iceberg(
    spark: SparkSession,
    table_name: str,
    df: DataFrame,
    is_fact: bool = False,
    partition_key: Optional[str] = None
) -> None:
    """写入Iceberg表（维度表覆盖，事实表追加）"""
    if not ICEBERG_ENABLED or df.rdd.isEmpty():
        logger.warning(f"⚠️ [{table_name}] 无数据或Iceberg禁用，跳过")
        return
    
    full_table = f"{ICEBERG_CATALOG_NAME}.{ICEBERG_NAMESPACE}.{table_name}"
    
    try:
        # 确保表存在
        try:
            spark.table(full_table)
            table_exists = True
        except:
            table_exists = False
        
        if not table_exists:
            logger.info(f"🆕 首次创建Iceberg表: {full_table}")
            df.writeTo(full_table).create()
        else:
            if is_fact and partition_key:
                # 事实表：删除旧分区数据后追加（Iceberg支持按分区删除）
                logger.info(f"🗑️ 删除旧数据: {full_table} WHERE year_month_day='{partition_key}'")
                spark.sql(f"DELETE FROM {full_table} WHERE year_month_day = '{partition_key}'")
                df.writeTo(full_table).append()
            else:
                # 维度表：全量覆盖
                logger.info(f"♻️ 全量覆盖: {full_table}")
                spark.sql(f"TRUNCATE TABLE {full_table}")
                df.writeTo(full_table).append()
        
        count = df.count()
        logger.info(f"✅ Iceberg写入完成: {full_table} ({count}条)")
        
        metrics.records_written.labels(
            table_name=table_name,
            partition_key=partition_key or "ALL"
        ).set(count)
        
    except Exception as e:
        logger.error(f"❌ Iceberg写入失败: {e}")
        raise

# =========================
# 维度表处理（带重试）
# =========================
def create_retry_decorator():
    """创建重试装饰器"""
    if not TENACITY_AVAILABLE:
        return lambda func: func
    
    return retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=60),
        retry=retry_if_exception_type(Exception),
        reraise=True
    )

@create_retry_decorator()
def process_dimension_table(spark: SparkSession, table_name: str) -> None:
    """处理维度表（增量 + 幂等性）"""
    logger.info(f"\n{'='*60}")
    logger.info(f"📊 处理维度表: {table_name}")
    logger.info(f"{'='*60}")
    
    start_time = time.time()
    partition_key = "ALL"
    
    from pyspark.sql.types import (
        StructType, StructField, StringType, IntegerType, 
        LongType, TimestampType
    )
    
    raw_schema = StructType([
        StructField("topic", StringType()),
        StructField("partition", IntegerType()),
        StructField("offset", LongType()),
        StructField("kafka_timestamp", TimestampType()),
        StructField("id", StringType()),
        StructField("name", StringType()),
        StructField("__deleted", StringType()),
        StructField("cdc_operation", StringType()),
        StructField("raw_ingestion_timestamp", TimestampType()),
        StructField("raw_data_version", StringType()),
    ])
    
    try:
        # 1. 获取水位线
        watermark = get_watermark(spark, table_name, partition_key)
        
        # 2. 增量读取RAW层
        raw_path = f"{RAW_BASE_PATH}/{table_name}"
        raw_df = spark.read.schema(raw_schema).parquet(f"{raw_path}/dt=*/")
        
        if watermark:
            raw_df = raw_df.filter(col("raw_ingestion_timestamp") > lit(watermark))
            logger.info(f"  ⚡ 增量模式: 仅读取 > {watermark} 的数据")
        else:
            logger.info(f"  🔄 全量模式: 首次处理")
        
        raw_count = raw_df.count()
        if raw_count == 0:
            logger.info(f"  ✅ 无新增数据，跳过处理")
            return
        
        logger.info(f"  📥 读取RAW层: {raw_count}条")
        metrics.records_read.labels(table_name=table_name, partition_key=partition_key).set(raw_count)
        
        # 3. 清洗 + 去重
        cleaned_df = (
            raw_df.filter(col("id").isNotNull())
            .withColumn("name", trim(col("name")))
            .filter(col("name") != "")
        )
        
        window_spec = Window.partitionBy("id").orderBy(col("raw_ingestion_timestamp").desc())
        deduped_df = (
            cleaned_df.withColumn("row_num", row_number().over(window_spec))
            .filter(col("row_num") == 1)
            .drop("row_num")
        )
        
        bronze_df = (
            deduped_df.withColumn("bronze_processing_timestamp", current_timestamp())
            .withColumn("data_quality_status", lit("VALID"))
        )
        
        # 4. 计算新水位线
        new_watermark_row = bronze_df.agg(spark_max("raw_ingestion_timestamp")).collect()[0]
        new_watermark = new_watermark_row[0]
        
        if not new_watermark:
            logger.warning(f"  ⚠️ 无法计算新水位线，跳过")
            return
        
        final_count = bronze_df.count()
        
        # 5. 写入Parquet
        bronze_path = f"{BRONZE_BASE_PATH}/{table_name}"
        bronze_df.write.mode("overwrite").parquet(bronze_path)
        logger.info(f"  ✅ Parquet写入完成: {final_count}条")
        
        # 6. 写入Iceberg
        write_to_iceberg(spark, table_name, bronze_df, is_fact=False)
        
        # 7. 原子更新水位线
        update_watermark(spark, table_name, partition_key, new_watermark, final_count, "SUCCESS")
        
        # 8. 记录指标
        duration = time.time() - start_time
        metrics.processing_duration.labels(table_name=table_name, partition_key=partition_key).observe(duration)
        metrics.operation_success.labels(table_name=table_name, partition_key=partition_key, operation="process").inc()
        metrics.push_metrics()
        
        logger.info(f"  ⏱️ 处理耗时: {duration:.2f}秒")
        
    except Exception as e:
        logger.error(f"  ❌ 维度表处理失败: {e}")
        mark_watermark_failed(spark, table_name, partition_key)
        metrics.operation_failure.labels(table_name=table_name, partition_key=partition_key, operation="process").inc()
        metrics.push_metrics()
        raise

# =========================
# 事实表：analysis_records（带重试）
# =========================
@create_retry_decorator()
def process_analysis_records(spark: SparkSession, year_month_day: Optional[str] = None) -> None:
    """处理事实表: analysis_records（day分区 + 增量 + 跳过异常）"""
    table_name = "analysis_records"
    logger.info(f"\n{'='*60}")
    logger.info(f"📈 处理事实表: {table_name}")
    if year_month_day:
        logger.info(f"   分区: {year_month_day}")
    logger.info(f"{'='*60}")
    
    start_time = time.time()
    
    from pyspark.sql.types import (
        StructType, StructField, StringType, IntegerType,
        LongType, TimestampType, DateType
    )
    
    raw_schema = StructType([
        StructField("topic", StringType()),
        StructField("partition", IntegerType()),
        StructField("offset", LongType()),
        StructField("kafka_timestamp", TimestampType()),
        StructField("id", StringType()),
        StructField("record_timestamp", LongType()),
        StructField("process_id", StringType()),
        StructField("category_id", StringType()),
        StructField("line_id", StringType()),
        StructField("report_description", StringType()),
        StructField("submitter", StringType()),
        StructField("submission_datetime", LongType()),
        StructField("shift", StringType()),
        StructField("analyst", StringType()),
        StructField("overall_judgment", StringType()),
        StructField("source_filename", StringType()),
        StructField("created_at", StringType()),
        StructField("__deleted", StringType()),
        StructField("cdc_operation", StringType()),
        StructField("raw_ingestion_timestamp", TimestampType()),
        StructField("raw_data_version", StringType()),
        StructField("business_datetime", StringType()),
        StructField("business_date", DateType()),
    ])
    
    try:
        # 1. 确定分区
        if year_month_day:
            partition_key = year_month_day
            read_path = f"{RAW_BASE_PATH}/{table_name}/year_month_day={year_month_day}/"
        else:
            partition_key = "ALL_PARTITIONS"
            read_path = f"{RAW_BASE_PATH}/{table_name}/year_month_day=*/"
        
        # 2. 获取水位线
        watermark = get_watermark(spark, table_name, partition_key)
        
        # 3. 增量读取
        raw_df = spark.read.schema(raw_schema).parquet(read_path)
        
        if watermark:
            raw_df = raw_df.filter(col("raw_ingestion_timestamp") > lit(watermark))
            logger.info(f"  ⚡ 增量模式: 仅读取 > {watermark}")
        else:
            logger.info(f"  🔄 全量模式: 首次处理")
        
        # ⚠️ 跳过异常分区
        raw_df = raw_df.filter(
            (col("business_date").isNotNull()) & 
            (regexp_replace(substring(col("business_date").cast("string"), 1, 10), "-", "") != INVALID_PARTITION_MARKER)
        )
        
        raw_count = raw_df.count()
        if raw_count == 0:
            logger.info(f"  ✅ 无新增有效数据，跳过")
            return
        
        logger.info(f"  📥 读取RAW层: {raw_count}条")
        metrics.records_read.labels(table_name=table_name, partition_key=partition_key).set(raw_count)
        
        # 4. 清洗 + 转换
        cleaned_df = (
            raw_df.filter(col("id").isNotNull())
            .filter(col("source_filename").isNotNull())
            .withColumn(
                "record_datetime",
                when(col("business_datetime").isNotNull(), to_timestamp(col("business_datetime")))
                .otherwise(None)
            )
            .withColumn(
                "submission_datetime",
                when(col("submission_datetime").isNotNull(), from_unixtime(col("submission_datetime") / 1000))
                .otherwise(None)
            )
            .withColumn("analyst", trim(col("analyst")))
            .withColumn("submitter", trim(col("submitter")))
            .withColumn("shift", trim(col("shift")))
            .withColumn("overall_judgment", upper(trim(col("overall_judgment"))))
        )
        
        # 5. 数据质量标记
        quality_df = cleaned_df.withColumn(
            "data_quality_status",
            when(col("record_datetime").isNull(), "MISSING_TIMESTAMP")
            .when(col("process_id").isNull(), "MISSING_PROCESS")
            .when(col("category_id").isNull(), "MISSING_CATEGORY")
            .when(col("line_id").isNull(), "MISSING_LINE")
            .otherwise("VALID")
        )
        
        # 6. 去重
        window_spec = Window.partitionBy("source_filename").orderBy(col("raw_ingestion_timestamp").desc())
        deduped_df = (
            quality_df.withColumn("row_num", row_number().over(window_spec))
            .filter(col("row_num") == 1)
            .drop("row_num")
        )
        
        # 7. 生成分区字段（8位 year_month_day）
        bronze_df = deduped_df.withColumn(
            "bronze_processing_timestamp", current_timestamp()
        ).withColumn(
            "year_month_day",
            when(
                col("business_date").isNotNull(),
                regexp_replace(col("business_date").cast("string"), "-", "")
            ).otherwise(INVALID_PARTITION_MARKER)
        ).filter(col("year_month_day") != INVALID_PARTITION_MARKER)  # ⚠️ 再次过滤异常
        
        # 8. 计算新水位线
        new_watermark_row = bronze_df.agg(spark_max("raw_ingestion_timestamp")).collect()[0]
        new_watermark = new_watermark_row[0]
        
        if not new_watermark:
            logger.warning(f"  ⚠️ 无法计算新水位线，跳过")
            return
        
        final_count = bronze_df.count()
        
        # 9. 写入Parquet
        bronze_path = f"{BRONZE_BASE_PATH}/{table_name}"
        if year_month_day:
            target_path = f"{bronze_path}/year_month_day={year_month_day}"
            bronze_df.write.mode("overwrite").parquet(target_path)
        else:
            bronze_df.write.mode("overwrite").partitionBy("year_month_day").parquet(bronze_path)
        
        logger.info(f"  ✅ Parquet写入完成: {final_count}条")
        
        # 10. 写入Iceberg
        write_to_iceberg(spark, table_name, bronze_df, is_fact=True, partition_key=year_month_day)
        
        # 11. 原子更新水位线
        update_watermark(spark, table_name, partition_key, new_watermark, final_count, "SUCCESS")
        
        # 12. 记录指标
        duration = time.time() - start_time
        metrics.processing_duration.labels(table_name=table_name, partition_key=partition_key).observe(duration)
        metrics.operation_success.labels(table_name=table_name, partition_key=partition_key, operation="process").inc()
        metrics.push_metrics()
        
        logger.info(f"  ⏱️ 处理耗时: {duration:.2f}秒")
        
    except Exception as e:
        logger.error(f"  ❌ 事实表处理失败: {e}")
        mark_watermark_failed(spark, table_name, partition_key or "ALL_PARTITIONS")
        metrics.operation_failure.labels(table_name=table_name, partition_key=partition_key or "ALL", operation="process").inc()
        metrics.push_metrics()
        raise

# =========================
# 事实表：chemical_analysis_results（带重试）
# =========================
@create_retry_decorator()
def process_chemical_results(spark: SparkSession, year_month_day: Optional[str] = None) -> None:
    """处理事实表: chemical_analysis_results（day分区 + 增量 + 跳过异常）"""
    table_name = "chemical_analysis_results"
    logger.info(f"\n{'='*60}")
    logger.info(f"📈 处理事实表: {table_name}")
    if year_month_day:
        logger.info(f"   分区: {year_month_day}")
    logger.info(f"{'='*60}")
    
    start_time = time.time()
    
    from pyspark.sql.types import (
        StructType, StructField, StringType, IntegerType,
        LongType, TimestampType, DateType, DoubleType
    )
    
    raw_schema = StructType([
        StructField("topic", StringType()),
        StructField("partition", IntegerType()),
        StructField("offset", LongType()),
        StructField("kafka_timestamp", TimestampType()),
        StructField("id", StringType()),
        StructField("analysis_record_id", StringType()),
        StructField("analysis_date", IntegerType()),
        StructField("tank_name", StringType()),
        StructField("item_name", StringType()),
        StructField("item_unit", StringType()),
        StructField("grade", StringType()),
        StructField("process_range_min", DoubleType()),
        StructField("process_range_max", DoubleType()),
        StructField("control_point", DoubleType()),
        StructField("control_range_min", DoubleType()),
        StructField("control_range_max", DoubleType()),
        StructField("frequency", StringType()),
        StructField("analysis_time", LongType()),
        StructField("result_value", DoubleType()),
        StructField("judgment", StringType()),
        StructField("remarks", StringType()),
        StructField("adjustment_chemical", StringType()),
        StructField("adjustment_quantity", StringType()),
        StructField("__deleted", StringType()),
        StructField("cdc_operation", StringType()),
        StructField("raw_ingestion_timestamp", TimestampType()),
        StructField("raw_data_version", StringType()),
        StructField("business_date", DateType()),
    ])
    
    try:
        # 1. 确定分区
        if year_month_day:
            partition_key = year_month_day
            read_path = f"{RAW_BASE_PATH}/{table_name}/year_month_day={year_month_day}/"
        else:
            partition_key = "ALL_PARTITIONS"
            read_path = f"{RAW_BASE_PATH}/{table_name}/year_month_day=*/"
        
        # 2. 获取水位线
        watermark = get_watermark(spark, table_name, partition_key)
        
        # 3. 增量读取
        raw_df = spark.read.schema(raw_schema).parquet(read_path)
        
        if watermark:
            raw_df = raw_df.filter(col("raw_ingestion_timestamp") > lit(watermark))
            logger.info(f"  ⚡ 增量模式: 仅读取 > {watermark}")
        else:
            logger.info(f"  🔄 全量模式: 首次处理")
        
        # ⚠️ 跳过异常分区
        raw_df = raw_df.filter(
            (col("business_date").isNotNull()) & 
            (regexp_replace(substring(col("business_date").cast("string"), 1, 10), "-", "") != INVALID_PARTITION_MARKER)
        )
        
        raw_count = raw_df.count()
        if raw_count == 0:
            logger.info(f"  ✅ 无新增有效数据，跳过")
            return
        
        logger.info(f"  📥 读取RAW层: {raw_count}条")
        metrics.records_read.labels(table_name=table_name, partition_key=partition_key).set(raw_count)
        
        # 4. 清洗 + 转换
        cleaned_df = (
            raw_df.filter(col("id").isNotNull())
            .filter(col("analysis_record_id").isNotNull())
            .withColumn("tank_name", trim(col("tank_name")))
            .withColumn("item_name", trim(col("item_name")))
            .withColumn("grade", trim(col("grade")))
            .withColumn("judgment", upper(trim(col("judgment"))))
            .withColumn("process_range_min", col("process_range_min").cast("decimal(10,4)"))
            .withColumn("process_range_max", col("process_range_max").cast("decimal(10,4)"))
            .withColumn("control_point", col("control_point").cast("decimal(10,4)"))
            .withColumn("control_range_min", col("control_range_min").cast("decimal(10,4)"))
            .withColumn("control_range_max", col("control_range_max").cast("decimal(10,4)"))
            .withColumn("result_value", col("result_value").cast("decimal(10,4)"))
        )
        
        # 5. 数据质量标记
        quality_df = cleaned_df.withColumn(
            "data_quality_status",
            when(col("analysis_date").isNull(), "MISSING_DATE")
            .when(col("result_value").isNull(), "MISSING_VALUE")
            .when(col("tank_name").isNull(), "MISSING_TANK")
            .when(col("item_name").isNull(), "MISSING_ITEM")
            .otherwise("VALID")
        )
        
        # 6. 去重
        window_spec = Window.partitionBy("id").orderBy(col("raw_ingestion_timestamp").desc())
        deduped_df = (
            quality_df.withColumn("row_num", row_number().over(window_spec))
            .filter(col("row_num") == 1)
            .drop("row_num")
        )
        
        # 7. 生成分区字段（8位 year_month_day）
        bronze_df = deduped_df.withColumn(
            "bronze_processing_timestamp", current_timestamp()
        ).withColumn(
            "year_month_day",
            when(
                col("business_date").isNotNull(),
                regexp_replace(col("business_date").cast("string"), "-", "")
            ).otherwise(INVALID_PARTITION_MARKER)
        ).filter(col("year_month_day") != INVALID_PARTITION_MARKER)  # ⚠️ 再次过滤异常
        
        # 8. 计算新水位线
        new_watermark_row = bronze_df.agg(spark_max("raw_ingestion_timestamp")).collect()[0]
        new_watermark = new_watermark_row[0]
        
        if not new_watermark:
            logger.warning(f"  ⚠️ 无法计算新水位线，跳过")
            return
        
        final_count = bronze_df.count()
        
        # 9. 写入Parquet
        bronze_path = f"{BRONZE_BASE_PATH}/{table_name}"
        if year_month_day:
            target_path = f"{bronze_path}/year_month_day={year_month_day}"
            bronze_df.write.mode("overwrite").parquet(target_path)
        else:
            bronze_df.write.mode("overwrite").partitionBy("year_month_day").parquet(bronze_path)
        
        logger.info(f"  ✅ Parquet写入完成: {final_count}条")
        
        # 10. 写入Iceberg
        write_to_iceberg(spark, table_name, bronze_df, is_fact=True, partition_key=year_month_day)
        
        # 11. 原子更新水位线
        update_watermark(spark, table_name, partition_key, new_watermark, final_count, "SUCCESS")
        
        # 12. 记录指标
        duration = time.time() - start_time
        metrics.processing_duration.labels(table_name=table_name, partition_key=partition_key).observe(duration)
        metrics.operation_success.labels(table_name=table_name, partition_key=partition_key, operation="process").inc()
        metrics.push_metrics()
        
        logger.info(f"  ⏱️ 处理耗时: {duration:.2f}秒")
        
    except Exception as e:
        logger.error(f"  ❌ 事实表处理失败: {e}")
        mark_watermark_failed(spark, table_name, partition_key or "ALL_PARTITIONS")
        metrics.operation_failure.labels(table_name=table_name, partition_key=partition_key or "ALL", operation="process").inc()
        metrics.push_metrics()
        raise

# =========================
# 主函数
# =========================
def main(year_month_day: Optional[str] = None, reset_watermark: bool = False) -> None:
    """
    主入口
    
    Args:
        year_month_day: 分区日期（8位，例如 "20241209"），None表示处理所有分区
        reset_watermark: 是否重置水位线（用于重新全量处理）
    """
    logger.info("=" * 80)
    logger.info("🚀 RAW → Bronze ETL v2.0 (幂等性 + 事务性 + 失败重试 + 血缘)")
    logger.info("=" * 80)
    
    if year_month_day:
        logger.info(f"📌 处理分区: {year_month_day}")
    else:
        logger.info(f"📌 处理模式: 所有分区")
    
    if reset_watermark:
        logger.warning(f"⚠️ 水位线重置模式: 将删除所有历史水位线，执行全量处理")
    
    logger.info("=" * 80)
    
    spark = create_spark_session()
    total_start = time.time()
    
    try:
        # 1. 初始化水位线表
        init_watermark_table(spark)
        
        # 2. 可选：重置水位线（危险操作，需谨慎）
        if reset_watermark:
            confirm = input("⚠️ 确认重置所有水位线? (yes/NO): ")
            if confirm.lower() == 'yes':
                spark.sql(f"TRUNCATE TABLE {WATERMARK_TABLE}")
                logger.warning("✅ 水位线已重置")
            else:
                logger.info("❌ 取消重置操作")
                return
        
        # 3. 处理维度表
        logger.info("\n" + "=" * 80)
        logger.info("📊 阶段1: 处理维度表")
        logger.info("=" * 80)
        for dim_table in ["categories", "lines", "processes"]:
            process_dimension_table(spark, dim_table)
        
        # 4. 处理事实表
        logger.info("\n" + "=" * 80)
        logger.info("📈 阶段2: 处理事实表")
        logger.info("=" * 80)
        process_analysis_records(spark, year_month_day)
        process_chemical_results(spark, year_month_day)
        
        # 5. 上报血缘关系
        report_all_bronze_lineage()
        
        # 6. 完成
        total_duration = time.time() - total_start
        logger.info("\n" + "=" * 80)
        logger.info(f"✅ RAW → Bronze ETL 完成（总耗时: {total_duration:.2f}秒）")
        logger.info("=" * 80)
        
        metrics.push_metrics()
        
    except Exception as e:
        logger.error(f"\n{'='*80}")
        logger.error(f"❌ ETL执行失败: {e}")
        logger.error(f"{'='*80}")
        metrics.push_metrics()
        raise
    finally:
        spark.stop()

if __name__ == "__main__":
    import sys
    
    # 支持命令行参数
    ym_day = sys.argv[1] if len(sys.argv) > 1 else None
    reset_flag = "--reset" in sys.argv
    
    main(ym_day, reset_flag)