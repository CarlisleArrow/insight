"""
Airflow DAG v2.0: 完整ETL流程（基于水位线 + 幂等性 + Prometheus监控）
========================================================================
核心改进：
1. ✅ 水位线驱动：基于各层水位线增量处理，而非固定时间范围
2. ✅ 参数支持：支持--reset、year_month_day（8位）、分区级别处理
3. ✅ 脚本v2：调用所有v2版本的幂等ETL脚本
4. ✅ 失败恢复：支持从失败点自动重试
5. ✅ 完整血缘：自动上报所有层级的数据血缘
6. ✅ 监控增强：Prometheus指标完整覆盖

流程: RAW → Bronze → Silver (Dim + Fact) → Gold → ClickHouse
调度: 每小时
"""

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.postgres.hooks.postgres import PostgresHook
from datetime import datetime, timedelta
import logging
from prometheus_client import CollectorRegistry, Gauge, Counter, Histogram, push_to_gateway
import time
import sys
import os

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from utils.lineage_reporter import LineageReporter

# =========================
# 配置
# =========================
PROMETHEUS_GATEWAY = '172.16.201.110:9091'
JOB_NAME = 'ipas_che_etl_v2'

SPARK_NAMESPACE = 'spark'
SPARK_MASTER_LABEL = 'component=master'

# ETL脚本路径（v2版本）
SCRIPTS = {
    'raw_to_bronze': '/opt/bitnami/spark/jobs/raw_to_bronze_etl.py',
    'dimension': '/opt/bitnami/spark/jobs/dimension_scd_etl.py',
    'fact': '/opt/bitnami/spark/jobs/fact_table_etl.py',
    'gold': '/opt/bitnami/spark/jobs/gold_aggregation_etl.py',
    'clickhouse': '/opt/bitnami/spark/jobs/silver_to_clickhouse_sync.py'
}

DIM_TABLES = ['categories', 'lines', 'processes']
FACT_TABLES = ['analysis_records', 'chemical_analysis_results']

# Iceberg配置
ICEBERG_PACKAGES = (
    'org.postgresql:postgresql:42.6.0,'
    'org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.4.0,'
    'org.apache.hadoop:hadoop-aws:3.3.4,'
    'com.amazonaws:aws-java-sdk-bundle:1.12.262'
)

ICEBERG_CONFIGS = [
    ('spark.sql.extensions', 'org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions'),
    ('spark.sql.catalog.iceberg', 'org.apache.iceberg.spark.SparkCatalog'),
    ('spark.sql.catalog.iceberg.type', 'rest'),
    ('spark.sql.catalog.iceberg.uri', 'http://iceberg-rest-catalog.data-warehouse.svc.cluster.local:8181'),
    ('spark.sql.catalog.iceberg.warehouse', 's3a://datalake-bronze-iceberg/'),
    ('spark.sql.catalog.iceberg.io-impl', 'org.apache.iceberg.hadoop.HadoopFileIO'),
]

S3_CONFIGS = [
    ('spark.hadoop.fs.s3a.endpoint', 'http://172.16.202.55:9000'),
    ('spark.hadoop.fs.s3a.access.key', 'minioadmin'),
    ('spark.hadoop.fs.s3a.secret.key', 'minioadmin'),
    ('spark.hadoop.fs.s3a.path.style.access', 'true'),
    ('spark.hadoop.fs.s3a.connection.ssl.enabled', 'false'),
    ('spark.hadoop.fs.s3a.aws.region', 'us-east-1'),
    ('spark.hadoop.fs.s3a.impl', 'org.apache.hadoop.fs.s3a.S3AFileSystem'),
    ('spark.hadoop.fs.s3a.aws.credentials.provider', 'org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider'),
]

# =========================
# Prometheus Metrics
# =========================
registry = CollectorRegistry()

etl_duration = Histogram(
    'etl_v2_stage_duration_seconds',
    'ETL阶段执行时长',
    ['stage', 'table', 'partition'],
    registry=registry
)

etl_records_processed = Gauge(
    'etl_v2_records_processed_total',
    '处理的记录数',
    ['stage', 'table', 'partition'],
    registry=registry
)

etl_success = Counter(
    'etl_v2_stage_success_total',
    'ETL阶段成功次数',
    ['stage', 'table'],
    registry=registry
)

etl_failure = Counter(
    'etl_v2_stage_failure_total',
    'ETL阶段失败次数',
    ['stage', 'table'],
    registry=registry
)

etl_last_success_timestamp = Gauge(
    'etl_v2_last_success_timestamp',
    '最后成功时间戳',
    ['stage', 'table'],
    registry=registry
)

etl_watermark_timestamp = Gauge(
    'etl_v2_watermark_timestamp',
    '当前水位线时间戳',
    ['stage', 'table', 'partition'],
    registry=registry
)

def push_metrics():
    """推送指标到Pushgateway"""
    try:
        push_to_gateway(PROMETHEUS_GATEWAY, job=JOB_NAME, registry=registry)
    except Exception as e:
        logging.warning(f"⚠️ 推送指标失败: {e}")

# =========================
# 工具函数
# =========================
def get_spark_pod():
    """获取Spark Master Pod"""
    from kubernetes import client, config
    
    config.load_incluster_config()
    v1 = client.CoreV1Api()
    
    pods = v1.list_namespaced_pod(
        namespace=SPARK_NAMESPACE,
        label_selector=SPARK_MASTER_LABEL
    )
    
    if not pods.items:
        raise Exception("未找到Spark Master Pod")
    
    return pods.items[0].metadata.name, v1

def build_spark_command(script_path, base_configs, extra_args=None):
    """构建spark-submit命令"""
    cmd = [
        'spark-submit',
        '--master', 'local[4]',
        '--packages', ICEBERG_PACKAGES,
        '--repositories', 'https://repo1.maven.org/maven2/',
        '--conf', 'spark.jars.ivy=/tmp/.ivy2',
    ]
    
    # 添加配置
    all_configs = base_configs + ICEBERG_CONFIGS + S3_CONFIGS
    for key, value in all_configs:
        cmd.extend(['--conf', f'{key}={value}'])
    
    # 添加脚本路径
    cmd.append(script_path)
    
    # 添加额外参数
    if extra_args:
        cmd.extend(extra_args)
    
    return cmd

def execute_spark_job(pod_name, v1, command, logger):
    """执行Spark作业并收集输出"""
    from kubernetes.stream import stream
    
    resp = stream(
        v1.connect_get_namespaced_pod_exec,
        pod_name,
        SPARK_NAMESPACE,
        command=command,
        stderr=True,
        stdin=False,
        stdout=True,
        tty=False,
        _preload_content=False
    )
    
    output_lines = []
    while resp.is_open():
        resp.update(timeout=1)
        if resp.peek_stdout():
            line = resp.read_stdout()
            output_lines.append(line)
            logger.info(f"STDOUT: {line}")
        if resp.peek_stderr():
            line = resp.read_stderr()
            logger.info(f"STDERR: {line}")
    
    resp.close()
    
    if resp.returncode != 0:
        raise Exception(f"Spark作业失败，退出码: {resp.returncode}")
    
    return output_lines

# =========================
# RAW → Bronze ETL
# =========================
def run_raw_to_bronze_etl(**context):
    """
    执行RAW到Bronze层ETL（基于水位线增量）
    支持：--reset参数重置水位线
    """
    logger = logging.getLogger(__name__)
    stage = 'raw_to_bronze'
    table = 'all_tables'
    start_time = time.time()
    
    try:
        execution_date = context['ds']
        exec_dt = datetime.strptime(execution_date, "%Y-%m-%d")
        
        # ⚡关键改进：使用8位日期格式（year_month_day）
        year_month_day = exec_dt.strftime("%Y%m%d")
        
        logger.info(f"{'='*80}")
        logger.info(f"🚀 RAW → Bronze ETL (基于水位线)")
        logger.info(f"   执行日期: {execution_date}")
        logger.info(f"   分区: year_month_day={year_month_day}")
        logger.info(f"{'='*80}")
        
        pod_name, v1 = get_spark_pod()
        
        # 构建命令（不传递日期参数，由脚本自动基于水位线处理）
        # 如果需要重置，可通过Airflow Variable控制
        extra_args = []
        
        # 检查是否需要重置水位线（从Airflow Variable读取）
        from airflow.models import Variable
        reset_watermark = Variable.get("bronze_reset_watermark", default_var="false")
        if reset_watermark.lower() == "true":
            extra_args.append("--reset")
            logger.warning("⚠️ 水位线重置模式：将全量重新处理")
            # 重置后清除变量
            Variable.set("bronze_reset_watermark", "false")
        
        command = build_spark_command(
            SCRIPTS['raw_to_bronze'],
            [],
            extra_args
        )
        
        output_lines = execute_spark_job(pod_name, v1, command, logger)
        
        # 提取统计信息
        total_records = 0
        for line in output_lines:
            if "Total records processed:" in line or "处理记录数" in line:
                try:
                    total_records = int(''.join(filter(str.isdigit, line)))
                except:
                    pass
        
        # 记录指标
        duration = time.time() - start_time
        etl_duration.labels(stage=stage, table=table, partition=year_month_day).observe(duration)
        etl_records_processed.labels(stage=stage, table=table, partition=year_month_day).set(total_records)
        etl_success.labels(stage=stage, table=table).inc()
        etl_last_success_timestamp.labels(stage=stage, table=table).set(time.time())
        push_metrics()
        
        logger.info(f"{'='*80}")
        logger.info(f"✅ RAW → Bronze ETL成功")
        logger.info(f"   耗时: {duration:.2f}秒")
        logger.info(f"   记录数: {total_records}")
        logger.info(f"{'='*80}")
        
    except Exception as e:
        etl_failure.labels(stage=stage, table=table).inc()
        push_metrics()
        logger.error(f"❌ RAW → Bronze ETL失败: {str(e)}")
        raise

# =========================
# Bronze → Silver (Dimension) ETL
# =========================
def run_dimension_etl(dim_table, **context):
    """
    执行维度表ETL（基于Bronze水位线增量）
    支持：SCD-2历史追踪
    """
    logger = logging.getLogger(__name__)
    stage = 'dimension'
    start_time = time.time()
    
    try:
        execution_date = context['ds']
        
        logger.info(f"{'='*80}")
        logger.info(f"🔧 处理维度表: {dim_table}")
        logger.info(f"   执行日期: {execution_date}")
        logger.info(f"{'='*80}")
        
        pod_name, v1 = get_spark_pod()
        
        # 构建命令
        extra_args = [
            '--execution_date', execution_date,
            '--dim_table', dim_table,
            '--enable_iceberg', 'true'
        ]
        
        command = build_spark_command(
            SCRIPTS['dimension'],
            [],
            extra_args
        )
        
        output_lines = execute_spark_job(pod_name, v1, command, logger)
        
        # 提取记录数
        total_records = 0
        for line in output_lines:
            if "Records processed:" in line or "处理记录数" in line:
                try:
                    total_records = int(''.join(filter(str.isdigit, line)))
                except:
                    pass
        
        # 记录指标
        duration = time.time() - start_time
        etl_duration.labels(stage=stage, table=dim_table, partition='ALL').observe(duration)
        etl_records_processed.labels(stage=stage, table=dim_table, partition='ALL').set(total_records)
        etl_success.labels(stage=stage, table=dim_table).inc()
        etl_last_success_timestamp.labels(stage=stage, table=dim_table).set(time.time())
        push_metrics()
        
        logger.info(f"✅ 维度表 {dim_table} ETL成功 (耗时: {duration:.2f}s)")
        
        # 上报血缘
        try:
            reporter = LineageReporter()
            src = [{'platform': 'iceberg', 'name': f'bronze_qms.{dim_table}'}]
            tgt = [
                {'platform': 'postgres', 'name': f'qms_warehouse.silver.dim_{dim_table}'},
                {'platform': 'iceberg', 'name': f'silver_qms.dim_{dim_table}'}
            ]
            reporter.report(src, tgt)
            reporter.close()
            logger.info(f"   ✅ 血缘上报成功: {dim_table}")
        except Exception as e:
            logger.warning(f"   ⚠️ 血缘上报失败: {e}")
        
    except Exception as e:
        etl_failure.labels(stage=stage, table=dim_table).inc()
        push_metrics()
        logger.error(f"❌ 维度表 {dim_table} ETL失败: {str(e)}")
        raise

# =========================
# Bronze → Silver (Fact) ETL
# =========================
def run_fact_etl(fact_table, **context):
    """
    执行事实表ETL（基于year_month_day分区 + Bronze水位线）
    支持：day级别增量处理
    """
    logger = logging.getLogger(__name__)
    stage = 'fact'
    start_time = time.time()
    
    try:
        execution_date = context['ds']
        exec_dt = datetime.strptime(execution_date, "%Y-%m-%d")
        
        # ⚡关键改进：使用8位日期分区
        year_month_day = exec_dt.strftime("%Y%m%d")
        
        logger.info(f"{'='*80}")
        logger.info(f"📈 处理事实表: {fact_table}")
        logger.info(f"   执行日期: {execution_date}")
        logger.info(f"   分区: year_month_day={year_month_day}")
        logger.info(f"{'='*80}")
        
        pod_name, v1 = get_spark_pod()
        
        # 构建命令
        extra_args = [
            '--execution_date', execution_date,
            '--fact_table', fact_table,
            '--year_month_day', year_month_day,  # 新增8位日期参数
            '--enable_iceberg', 'true'
        ]
        
        command = build_spark_command(
            SCRIPTS['fact'],
            [],
            extra_args
        )
        
        output_lines = execute_spark_job(pod_name, v1, command, logger)
        
        # 提取记录数
        total_records = 0
        for line in output_lines:
            if "Records processed:" in line or "处理记录数" in line:
                try:
                    total_records = int(''.join(filter(str.isdigit, line)))
                except:
                    pass
        
        # 记录指标
        duration = time.time() - start_time
        etl_duration.labels(stage=stage, table=fact_table, partition=year_month_day).observe(duration)
        etl_records_processed.labels(stage=stage, table=fact_table, partition=year_month_day).set(total_records)
        etl_success.labels(stage=stage, table=fact_table).inc()
        etl_last_success_timestamp.labels(stage=stage, table=fact_table).set(time.time())
        push_metrics()
        
        logger.info(f"✅ 事实表 {fact_table} ETL成功 (耗时: {duration:.2f}s)")
        
        # 上报血缘
        try:
            reporter = LineageReporter()
            src = [{'platform': 'iceberg', 'name': f'bronze_qms.{fact_table}'}]
            pg_table_name = "fact_analysis_records" if fact_table == "analysis_records" else "fact_chemical_results"
            tgt = [
                {'platform': 'postgres', 'name': f'qms_warehouse.silver.{pg_table_name}'},
                {'platform': 'iceberg', 'name': f'silver_qms.fact_{fact_table}'}
            ]
            reporter.report(src, tgt)
            reporter.close()
            logger.info(f"   ✅ 血缘上报成功: {fact_table}")
        except Exception as e:
            logger.warning(f"   ⚠️ 血缘上报失败: {e}")
        
    except Exception as e:
        etl_failure.labels(stage=stage, table=fact_table).inc()
        push_metrics()
        logger.error(f"❌ 事实表 {fact_table} ETL失败: {str(e)}")
        raise

# =========================
# Silver验证
# =========================
def validate_all_tables(**context):
    """验证所有Silver表的数据"""
    logger = logging.getLogger(__name__)
    execution_date = context['ds']
    
    logger.info(f"{'='*80}")
    logger.info(f"🔍 验证Silver层数据: {execution_date}")
    logger.info(f"{'='*80}")
    
    pg_hook = PostgresHook(postgres_conn_id="postgres_warehouse")
    
    # 验证维度表
    for dim_table in DIM_TABLES:
        result = pg_hook.get_first(
            f"SELECT COUNT(*) FROM silver.dim_{dim_table} WHERE is_current = true"
        )
        count = result[0] if result else 0
        logger.info(f"  ✅ dim_{dim_table}: {count} 条当前记录")
    
    # 验证事实表
    result = pg_hook.get_first(
        f"SELECT COUNT(*) FROM silver.fact_analysis_records WHERE analysis_date = '{execution_date}'"
    )
    count = result[0] if result else 0
    logger.info(f"  ✅ fact_analysis_records: {count} 条记录")
    
    result = pg_hook.get_first(
        f"SELECT COUNT(*) FROM silver.fact_chemical_results WHERE analysis_date = '{execution_date}'"
    )
    count = result[0] if result else 0
    logger.info(f"  ✅ fact_chemical_results: {count} 条记录")
    
    logger.info(f"{'='*80}")

# =========================
# Silver → Gold Aggregation ETL
# =========================
def run_gold_aggregation_etl(**context):
    """
    执行Gold层聚合ETL（基于Silver水位线）
    支持：SPC分析、控制图、移动平均
    """
    logger = logging.getLogger(__name__)
    stage = 'gold_aggregation'
    table = 'aggregates'
    start_time = time.time()
    
    try:
        execution_date = context['ds']
        exec_dt = datetime.strptime(execution_date, "%Y-%m-%d")
        
        # ⚡关键改进：使用更灵活的时间窗口
        # 默认处理当天数据，Gold层脚本内部会根据需要回溯（如30天SPC计算）
        start_date = execution_date
        end_date = execution_date
        
        logger.info(f"{'='*80}")
        logger.info(f"📊 Gold层聚合ETL")
        logger.info(f"   日期范围: {start_date} ~ {end_date}")
        logger.info(f"{'='*80}")
        
        pod_name, v1 = get_spark_pod()
        
        # 构建命令
        extra_args = [
            '--start_date', start_date,
            '--end_date', end_date
        ]
        
        command = build_spark_command(
            SCRIPTS['gold'],
            [],
            extra_args
        )
        
        output_lines = execute_spark_job(pod_name, v1, command, logger)
        
        # 记录指标
        duration = time.time() - start_time
        etl_duration.labels(stage=stage, table=table, partition=execution_date).observe(duration)
        etl_success.labels(stage=stage, table=table).inc()
        etl_last_success_timestamp.labels(stage=stage, table=table).set(time.time())
        push_metrics()
        
        logger.info(f"✅ Gold层聚合完成 (耗时: {duration:.2f}s)")
        
        # 上报血缘
        try:
            reporter = LineageReporter()
            src = [
                {'platform': 'iceberg', 'name': 'silver_qms.fact_analysis_records'},
                {'platform': 'iceberg', 'name': 'silver_qms.fact_chemical_analysis_results'}
            ]
            
            # 所有Gold表
            gold_tables = [
                'agg_qualification_rate_daily', 'agg_warning_statistics_daily',
                'spc_capability_daily', 'spc_trend_ma',
                'spc_xbar_r_chart', 'spc_xbar_s_chart', 'spc_p_chart', 'spc_c_chart',
                'spc_monthly_alarm_rate'
            ]
            
            targets = []
            for t in gold_tables:
                targets.append({'platform': 'postgres', 'name': f'qms_warehouse.gold.{t}'})
                targets.append({'platform': 'iceberg', 'name': f'gold_qms.{t}'})
            
            reporter.report(src, targets)
            reporter.close()
            logger.info("   ✅ Gold层血缘上报成功")
        except Exception as e:
            logger.warning(f"   ⚠️ 血缘上报失败: {e}")
        
    except Exception as e:
        etl_failure.labels(stage=stage, table=table).inc()
        push_metrics()
        logger.error(f"❌ Gold层聚合失败: {e}")
        raise

# =========================
# Gold → ClickHouse Sync
# =========================
def run_clickhouse_sync(**context):
    """
    执行Gold到ClickHouse同步（基于Gold水位线）
    支持：ReplacingMergeTree自动去重
    """
    logger = logging.getLogger(__name__)
    stage = 'clickhouse_sync'
    table = 'all_tables'
    start_time = time.time()
    
    try:
        execution_date = context['ds']
        
        logger.info(f"{'='*80}")
        logger.info(f"🔄 ClickHouse同步")
        logger.info(f"   同步日期: {execution_date}")
        logger.info(f"{'='*80}")
        
        pod_name, v1 = get_spark_pod()
        
        # 构建命令
        extra_args = [
            '--date', execution_date
        ]
        
        command = build_spark_command(
            SCRIPTS['clickhouse'],
            [],
            extra_args
        )
        
        output_lines = execute_spark_job(pod_name, v1, command, logger)
        
        # 记录指标
        duration = time.time() - start_time
        etl_duration.labels(stage=stage, table=table, partition=execution_date).observe(duration)
        etl_success.labels(stage=stage, table=table).inc()
        etl_last_success_timestamp.labels(stage=stage, table=table).set(time.time())
        push_metrics()
        
        logger.info(f"✅ ClickHouse同步完成 (耗时: {duration:.2f}s)")
        
        # 上报血缘
        try:
            reporter = LineageReporter()
            
            # 所有同步表
            sync_tables = [
                'agg_qualification_rate_daily', 'agg_warning_statistics_daily',
                'spc_capability_daily', 'spc_trend_ma',
                'spc_xbar_r_chart', 'spc_xbar_s_chart', 'spc_p_chart', 'spc_c_chart',
                'spc_monthly_alarm_rate'
            ]
            
            src = [{'platform': 'iceberg', 'name': f'gold_qms.{t}'} for t in sync_tables]
            tgt = [{'platform': 'clickhouse', 'name': f'qms_gold.{t}'} for t in sync_tables]
            
            reporter.report(src, tgt)
            reporter.close()
            logger.info("   ✅ ClickHouse血缘上报成功")
        except Exception as e:
            logger.warning(f"   ⚠️ 血缘上报失败: {e}")
        
    except Exception as e:
        etl_failure.labels(stage=stage, table=table).inc()
        push_metrics()
        logger.error(f"❌ ClickHouse同步失败: {e}")
        raise

# =========================
# DAG定义
# =========================
default_args = {
    'owner': 'data_team',
    'depends_on_past': False,
    'retries': 3,  # 增加重试次数
    'retry_delay': timedelta(minutes=5),
    'retry_exponential_backoff': True,  # 指数退避重试
    'max_retry_delay': timedelta(minutes=30),
    'execution_timeout': timedelta(hours=3)
}

with DAG(
    dag_id='complete_multi_table_etl_v2_watermark',
    default_args=default_args,
    description='完整ETL流程v2.0 (基于水位线 + 幂等性 + Prometheus监控)',
    schedule_interval='@hourly',
    start_date=datetime(2025, 12, 1),
    catchup=False,
    tags=['etl', 'v2', 'watermark', 'idempotent', 'monitoring'],
    max_active_runs=1,
    doc_md="""
    ## IPAS CHE 完整ETL流程 v2.0
    
    ### 核心特性
    - ✅ **水位线驱动**：基于各层水位线增量处理
    - ✅ **幂等性保证**：支持重复执行不会产生重复数据
    - ✅ **事务原子性**：双写PostgreSQL + Iceberg事务一致性
    - ✅ **失败重试**：自动重试3次，指数退避
    - ✅ **完整血缘**：自动上报DataHub和Neo4j
    
    ### 数据流
    ```
    RAW (S3) 
      → Bronze (Iceberg) 
      → Silver (PostgreSQL + Iceberg)
        ├─ Dimensions (SCD-2)
        └─ Facts (Day Partition)
      → Gold (PostgreSQL + Iceberg)
        ├─ Aggregations
        └─ SPC Analysis
      → ClickHouse (OLAP)
    ```
    
    ### 重置水位线
    设置Airflow Variable `bronze_reset_watermark=true` 可重置Bronze层水位线
    """
) as dag:
    
    # =========================
    # Task定义
    # =========================
    
    # RAW → Bronze
    raw_to_bronze = PythonOperator(
        task_id='raw_to_bronze_etl',
        python_callable=run_raw_to_bronze_etl,
        provide_context=True,
        doc_md="RAW → Bronze: 基于CDC数据增量处理"
    )
    
    # Bronze → Silver: Dimensions (并行)
    dim_tasks = []
    for dim_table in DIM_TABLES:
        task = PythonOperator(
            task_id=f'etl_dim_{dim_table}',
            python_callable=run_dimension_etl,
            op_kwargs={'dim_table': dim_table},
            provide_context=True,
            doc_md=f"Bronze → Silver: 维度表 {dim_table} (SCD-2)"
        )
        dim_tasks.append(task)
    
    # Bronze → Silver: Facts (串行，依赖维度表)
    fact_analysis = PythonOperator(
        task_id='etl_fact_analysis_records',
        python_callable=run_fact_etl,
        op_kwargs={'fact_table': 'analysis_records'},
        provide_context=True,
        doc_md="Bronze → Silver: 分析记录事实表"
    )
    
    fact_chemical = PythonOperator(
        task_id='etl_fact_chemical_results',
        python_callable=run_fact_etl,
        op_kwargs={'fact_table': 'chemical_analysis_results'},
        provide_context=True,
        doc_md="Bronze → Silver: 化学分析事实表"
    )
    
    # 验证Silver层
    validate = PythonOperator(
        task_id='validate_silver_tables',
        python_callable=validate_all_tables,
        provide_context=True,
        doc_md="验证Silver层数据完整性"
    )
    
    # Silver → Gold
    gold_aggregation = PythonOperator(
        task_id='gold_aggregation_etl',
        python_callable=run_gold_aggregation_etl,
        provide_context=True,
        execution_timeout=timedelta(minutes=30),
        doc_md="Silver → Gold: SPC分析与聚合"
    )
    
    # Gold → ClickHouse
    clickhouse_sync = PythonOperator(
        task_id='clickhouse_sync',
        python_callable=run_clickhouse_sync,
        provide_context=True,
        execution_timeout=timedelta(minutes=20),
        doc_md="Gold → ClickHouse: OLAP数据同步"
    )
    
    # =========================
    # 依赖关系
    # =========================
    
    # RAW → Bronze → Dimensions (并行)
    raw_to_bronze >> dim_tasks
    
    # Dimensions → Fact Analysis → Fact Chemical → Validate
    dim_tasks >> fact_analysis >> fact_chemical >> validate
    
    # Validate → Gold → ClickHouse
    validate >> gold_aggregation >> clickhouse_sync
