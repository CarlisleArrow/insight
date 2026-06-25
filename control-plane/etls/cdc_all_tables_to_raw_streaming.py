#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Spark Streaming: Kafka CDC → RAW 层 v2.0 (Day分区版)
--------------------------------------------------------------------
关键变更：
1. ✅ 分区粒度调整为 day: year_month_day = "20241209" (8位)
2. ✅ 跳过异常数据：year_month_day = "99999999" 不写入
3. ✅ 保持与Bronze ETL v2.0同步

功能：
  - 监听 5 张表的 Debezium CDC 事件 (Kafka)
  - 写入 MinIO RAW 层为 Parquet 文件
  - 每张表独立 checkpoint，支持自动恢复、避免数据丢失
  - 支持从 earliest / latest 启动 Kafka offset
  - 保留 CDC 字段(__deleted) + Kafka 元数据

表：
  - 维度表: categories, lines, processes (分区: dt = YYYY-MM-DD)
  - 事实表: analysis_records, chemical_analysis_results (分区: year_month_day = YYYYMMDD)
"""

import logging
import sys
from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    from_json, col, lit, current_timestamp,
    to_date, from_unixtime,
    regexp_replace, substring, when
)
from pyspark.sql.types import *

# ===========================
# 📦 血缘依赖
# ===========================
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
    logging.warning("⚠️ 缺少 datahub 或 neo4j 库，血缘上报将被跳过。pip install acryl-datahub neo4j")

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger("cdc_to_raw_v2_day_partition")

# =========================
# 配置
# =========================
KAFKA_BOOTSTRAP = "kafka-cluster.kafka.svc.cluster.local:9092"
KAFKA_TOPICS = [
    "qms.qms.categories",
    "qms.qms.lines",
    "qms.qms.processes",
    "qms.qms.analysis_records",
    "qms.qms.chemical_analysis_results",
]

MINIO_ENDPOINT = "http://172.16.202.55:9000"
MINIO_ACCESS_KEY = "minioadmin"
MINIO_SECRET_KEY = "minioadmin"
BASE_PATH = "s3a://datalake-raw/qms"
CHECKPOINT_BASE = "s3a://datalake-raw/spark-checkpoints/cdc-all-tables-v2"
STARTING_OFFSETS = "earliest"

# 异常数据标记（8位）
INVALID_PARTITION_MARKER = "99999999"

# =========================
# 🌐 血缘配置
# =========================
DATAHUB_GMS_URL = "http://172.16.202.60:9002/api/gms"
DATAHUB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhY3RvclR5cGUiOiJVU0VSIiwiYWN0b3JJZCI6ImRhdGFodWIiLCJ0eXBlIjoiUEVSU09OQUwiLCJ2ZXJzaW9uIjoiMiIsImp0aSI6ImFmZWFiZTEzLWJjMTMtNDU3Mi04N2I0LTkyN2QxNzcxNzdiNCIsInN1YiI6ImRhdGFodWIiLCJpc3MiOiJkYXRhaHViLW1ldGFkYXRhLXNlcnZpY2UifQ.s6wyrLe3vMtHNIbqO8Hqqtpj50Ej_9PHvFs_FAjVELk"

NEO4J_URI = "bolt://172.16.202.65:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "test"

# =========================
# Schema定义
# =========================
dim_schema = StructType([
    StructField("id", StringType()),
    StructField("name", StringType()),
    StructField("__deleted", StringType())
])

analysis_records_schema = StructType([
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
    StructField("__deleted", StringType())
])

chemical_results_schema = StructType([
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
    StructField("__deleted", StringType())
])

SCHEMAS = {
    "categories": dim_schema,
    "lines": dim_schema,
    "processes": dim_schema,
    "analysis_records": analysis_records_schema,
    "chemical_analysis_results": chemical_results_schema,
}

# =========================
# 🔗 数据血缘上报逻辑
# =========================
def report_streaming_lineage():
    """
    上报 Kafka → RAW (S3) 的血缘关系
    - DataHub: 记录数据集依赖关系
    - Neo4j (Amundsen): 记录表级血缘
    """
    if not LINEAGE_AVAILABLE:
        logger.warning("⚠️ 血缘依赖未安装，跳过血缘上报")
        return
    
    logger.info("\n" + "=" * 80)
    logger.info("📡 开始上报 Kafka → RAW Streaming 血缘...")
    logger.info("=" * 80)
    
    try:
        # 初始化连接
        emitter = DatahubRestEmitter(gms_server=DATAHUB_GMS_URL, token=DATAHUB_TOKEN)
        neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        neo4j_driver.verify_connectivity()
        logger.info("✅ DataHub & Neo4j 连接成功")
    except Exception as e:
        logger.error(f"❌ 血缘系统连接失败: {e}")
        return
    
    # 遍历Topic进行上报
    success_count = 0
    for topic in KAFKA_TOPICS:
        try:
            table_name = topic.split(".")[-1]
            
            # 定义URN
            src_platform = "kafka"
            src_name = topic
            src_urn = f"urn:li:dataset:(urn:li:dataPlatform:{src_platform},{src_name},PROD)"
            
            tgt_platform = "s3"
            tgt_name = f"datalake-raw/qms/{table_name}"
            tgt_urn = f"urn:li:dataset:(urn:li:dataPlatform:{tgt_platform},{tgt_name},PROD)"
            
            logger.info(f"   🔄 处理: {table_name}")
            logger.info(f"      Source: {src_urn}")
            logger.info(f"      Target: {tgt_urn}")
            
            # === DataHub 上报 ===
            # 1. 激活Source节点
            emitter.emit(MetadataChangeProposalWrapper(
                entityType="dataset", changeType="UPSERT", entityUrn=src_urn,
                aspectName="status", aspect=StatusClass(removed=False)
            ))
            
            # 2. 激活Target节点
            emitter.emit(MetadataChangeProposalWrapper(
                entityType="dataset", changeType="UPSERT", entityUrn=tgt_urn,
                aspectName="status", aspect=StatusClass(removed=False)
            ))
            
            # 3. 构建血缘关系（S3 指向 Kafka）
            lineage_aspect = UpstreamLineageClass(upstreams=[
                UpstreamClass(dataset=src_urn, type=DatasetLineageTypeClass.TRANSFORMED)
            ])
            
            emitter.emit(MetadataChangeProposalWrapper(
                entityType="dataset", changeType="UPSERT", entityUrn=tgt_urn,
                aspectName="upstreamLineage", aspect=lineage_aspect
            ))
            logger.info(f"      ✅ [DataHub] 血缘已发送")
            
            # === Neo4j (Amundsen) 上报 ===
            neo4j_src_key = f"{src_platform}://default.default/{src_name}"
            neo4j_tgt_key = f"{tgt_platform}://default.default/{tgt_name}"
            
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
            logger.info(f"      ✅ [Neo4j] 血缘已发送")
            
            success_count += 1
            
        except Exception as e:
            logger.error(f"   ❌ [Lineage] 上报失败 ({topic}): {e}")
    
    # 关闭连接
    neo4j_driver.close()
    
    logger.info("=" * 80)
    logger.info(f"📡 血缘上报完成: 成功 {success_count}/{len(KAFKA_TOPICS)} 个表")
    logger.info("=" * 80)
    logger.info("")


# =========================
# Spark Session
# =========================
def create_spark_session():
    spark = (
        SparkSession.builder
        .appName("CDC_to_RAW_v2_Day_Partition")
        .config("spark.hadoop.fs.s3a.endpoint", MINIO_ENDPOINT)
        .config("spark.hadoop.fs.s3a.access.key", MINIO_ACCESS_KEY)
        .config("spark.hadoop.fs.s3a.secret.key", MINIO_SECRET_KEY)
        .config("spark.hadoop.fs.s3a.path.style.access", "true")
        .config("spark.hadoop.fs.s3a.connection.ssl.enabled", "false")
        .config("spark.hadoop.fs.s3a.impl", "org.apache.hadoop.fs.s3a.S3AFileSystem")
        .config("spark.sql.adaptive.enabled", "true")
        .config("spark.sql.adaptive.coalescePartitions.enabled", "true")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("WARN")
    return spark

# =========================
# 核心处理逻辑
# =========================
def process_table_stream(spark, full_topic_name: str):
    table_name = full_topic_name.split(".")[-1]
    logger.info(f"🚀 启动CDC流: topic={full_topic_name} → table={table_name}")
    
    if table_name not in SCHEMAS:
        raise ValueError(f"未配置schema: {table_name}")
    
    # 1. 读取Kafka流
    kafka_df = (
        spark.readStream
        .format("kafka")
        .option("kafka.bootstrap.servers", KAFKA_BOOTSTRAP)
        .option("subscribe", full_topic_name)
        .option("startingOffsets", STARTING_OFFSETS)
        .option("failOnDataLoss", "false")
        .option("maxOffsetsPerTrigger", "2000")
        .load()
    )
    
    # 2. 解析JSON
    parsed_df = (
        kafka_df
        .select(
            col("topic"), col("partition"), col("offset"),
            col("timestamp").alias("kafka_timestamp"),
            from_json(col("value").cast("string"), SCHEMAS[table_name]).alias("data")
        )
        .select("topic", "partition", "offset", "kafka_timestamp", "data.*")
    )
    
    # 3. 增加元数据
    enriched_df = (
        parsed_df
        .withColumn("cdc_operation", lit("upsert"))
        .withColumn("raw_ingestion_timestamp", current_timestamp())
        .withColumn("raw_data_version", lit("2.0"))  # 版本标识
        .filter(col("id").isNotNull())
    )
    
    # 4. 分区策略（核心修改点）
    partition_cols = []
    
    if table_name in ["categories", "lines", "processes"]:
        # 维度表：dt分区（日期格式）
        enriched_df = enriched_df.withColumn("dt", to_date(current_timestamp()))
        partition_cols = ["dt"]
        logger.info(f"   分区策略: dt (维度表)")
        
    elif table_name == "analysis_records":
        # 事实表：year_month_day分区（8位数字）
        enriched_df = (
            enriched_df
            # 解析业务日期
            .withColumn(
                "business_datetime",
                when(
                    col("record_timestamp").isNotNull(),
                    from_unixtime(col("record_timestamp") / 1000, "yyyy-MM-dd HH:mm:ss")
                ).otherwise(None)
            )
            .withColumn("business_date", to_date(col("business_datetime")))
            # 生成8位分区字段
            .withColumn(
                "year_month_day",
                when(
                    col("business_date").isNotNull(),
                    regexp_replace(col("business_date").cast("string"), "-", "")
                ).otherwise(INVALID_PARTITION_MARKER)
            )
        )
        # ⚠️ 过滤异常数据：不写入99999999分区
        enriched_df = enriched_df.filter(col("year_month_day") != INVALID_PARTITION_MARKER)
        partition_cols = ["year_month_day"]
        logger.info(f"   分区策略: year_month_day (8位日期，跳过{INVALID_PARTITION_MARKER})")
        
    elif table_name == "chemical_analysis_results":
        # 事实表：year_month_day分区（8位数字）
        enriched_df = (
            enriched_df
            # 解析业务日期（analysis_date是天数或int）
            .withColumn(
                "business_date",
                when(
                    col("analysis_date").isNotNull(),
                    from_unixtime(col("analysis_date") * 86400).cast("date")
                ).otherwise(None)
            )
            # 生成8位分区字段
            .withColumn(
                "year_month_day",
                when(
                    col("business_date").isNotNull(),
                    regexp_replace(col("business_date").cast("string"), "-", "")
                ).otherwise(INVALID_PARTITION_MARKER)
            )
        )
        # ⚠️ 过滤异常数据
        enriched_df = enriched_df.filter(col("year_month_day") != INVALID_PARTITION_MARKER)
        partition_cols = ["year_month_day"]
        logger.info(f"   分区策略: year_month_day (8位日期，跳过{INVALID_PARTITION_MARKER})")
        
    else:
        # 默认：dt分区
        enriched_df = enriched_df.withColumn("dt", to_date(current_timestamp()))
        partition_cols = ["dt"]
        logger.info(f"   分区策略: dt (默认)")
    
    # 5. 写入配置
    output_path = f"{BASE_PATH}/{table_name}"
    checkpoint_path = f"{CHECKPOINT_BASE}/{table_name}"
    
    logger.info(f"   输出路径: {output_path}")
    logger.info(f"   Checkpoint: {checkpoint_path}")
    logger.info(f"   分区字段: {partition_cols}")
    
    # 6. 启动流写入
    query = (
        enriched_df
        .writeStream
        .format("parquet")
        .outputMode("append")
        .option("path", output_path)
        .option("checkpointLocation", checkpoint_path)
        .trigger(processingTime="10 seconds")
        .partitionBy(*partition_cols)
        .start()
    )
    
    return query

# =========================
# 主函数
# =========================
def main():
    logger.info("=" * 80)
    logger.info("🚀 CDC → RAW Streaming v2.0 (Day分区版 + 血缘上报)")
    logger.info("=" * 80)
    logger.info(f"📌 分区策略:")
    logger.info(f"   - 维度表: dt = YYYY-MM-DD")
    logger.info(f"   - 事实表: year_month_day = YYYYMMDD (8位)")
    logger.info(f"   - 异常数据标记: {INVALID_PARTITION_MARKER} (自动跳过)")
    logger.info("=" * 80)
    
    # --- 🟢 Step 1: 先执行血缘上报（独立步骤） ---
    report_streaming_lineage()
    
    # --- 🔵 Step 2: 再启动 Spark Streaming 任务 ---
    logger.info("⚙️ 正在初始化 Spark Session...")
    spark = create_spark_session()
    
    queries = []
    try:
        for topic in KAFKA_TOPICS:
            q = process_table_stream(spark, topic)
            queries.append(q)
        
        logger.info("=" * 80)
        logger.info(f"✅ 共启动 {len(queries)} 条 Streaming 任务")
        logger.info("=" * 80)
        
        for q in queries:
            q.awaitTermination()
    
    except Exception as e:
        logger.error(f"❌ CDC Streaming 失败: {e}")
        raise
    finally:
        try:
            spark.stop()
        except Exception:
            pass

if __name__ == "__main__":
    main()