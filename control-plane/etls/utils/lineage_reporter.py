import logging
import json
from datahub.emitter.rest_emitter import DatahubRestEmitter
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    DatasetLineageTypeClass,
    UpstreamLineageClass,
    UpstreamClass,
    StatusClass,  
    DatasetPropertiesClass 
)
from neo4j import GraphDatabase

# ================= 配置区域 =================
DATAHUB_GMS_URL = "http://172.16.202.60:9002/api/gms"
DATAHUB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhY3RvclR5cGUiOiJVU0VSIiwiYWN0b3JJZCI6ImRhdGFodWIiLCJ0eXBlIjoiUEVSU09OQUwiLCJ2ZXJzaW9uIjoiMiIsImp0aSI6ImFmZWFiZTEzLWJjMTMtNDU3Mi04N2I0LTkyN2QxNzcxNzdiNCIsInN1YiI6ImRhdGFodWIiLCJpc3MiOiJkYXRhaHViLW1ldGFkYXRhLXNlcnZpY2UifQ.s6wyrLe3vMtHNIbqO8Hqqtpj50Ej_9PHvFs_FAjVELk"

NEO4J_URI = "bolt://172.16.202.65:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "test" 
# ===========================================

logger = logging.getLogger("lineage_reporter")
logger.setLevel(logging.INFO)

class LineageReporter:
    def __init__(self):
        # DataHub 初始化
        self.dh_emitter = DatahubRestEmitter(
            gms_server=DATAHUB_GMS_URL,
            token=DATAHUB_TOKEN,
            connect_timeout_sec=10,
            read_timeout_sec=10
        )
        
        # Neo4j 初始化
        self.neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

    def _get_amundsen_key(self, platform, schema, table, cluster="default"):
        return f"{platform}://{cluster}.{schema}/{table}"

    def report(self, source_list, target_list):
        print(f"\n🚀 [DEBUG] 开始执行上报流程")
        print(f"👉 Sources: {json.dumps(source_list, ensure_ascii=False)}")
        print(f"👉 Targets: {json.dumps(target_list, ensure_ascii=False)}")

        # 1. 上报 DataHub
        try:
            print(f"🔄 [DataHub] 正在准备上报...")
            self._report_to_datahub(source_list, target_list)
            logger.info(f"✅ DataHub Lineage reported to {DATAHUB_GMS_URL}")
        except Exception as e:
            print(f"❌ [DataHub] 上报异常: {e}")
            logger.error(f"❌ DataHub Lineage failed: {e}")

        # 2. 上报 Amundsen (Neo4j)
        try:
            print(f"🔄 [Amundsen] 正在检查连接...")
            self.neo4j_driver.verify_connectivity()
            self._report_to_amundsen(source_list, target_list)
            logger.info(f"✅ Amundsen Lineage reported to {NEO4J_URI}")
        except Exception as e:
            print(f"❌ [Amundsen] 上报异常: {e}")
            logger.error(f"❌ Amundsen Lineage failed: {e}")

    def _report_to_datahub(self, sources, targets):
        if not targets:
            print("⚠️ [DataHub] 没有 Target，跳过上报")
            return

        # 构建上游列表 (Upstreams)
        upstream_tables = []
        for src in sources:
            # 1. 构建 Source URN
            src_urn = f"urn:li:dataset:(urn:li:dataPlatform:{src['platform']},{src['name']},PROD)"
            
            # =========================================================
            # 🛑【核心修复】显式激活 Source 节点，防止出现“幽灵断链”
            # =========================================================
            print(f"   🔨 [Force Activate] 正在强制注册上游节点: {src['name']}")
            try:
                # 1. 告诉 DataHub 这个数据集是“活动”状态 (Status)
                status_event = MetadataChangeProposalWrapper(
                    entityType="dataset",
                    changeType="UPSERT",
                    entityUrn=src_urn,
                    aspectName="status",
                    aspect=StatusClass(removed=False)
                )
                self.dh_emitter.emit(status_event)
                
                # 2. (可选) 给它一个显示名称，确保图标好看
                prop_event = MetadataChangeProposalWrapper(
                    entityType="dataset",
                    changeType="UPSERT",
                    entityUrn=src_urn,
                    aspectName="datasetProperties",
                    aspect=DatasetPropertiesClass(name=src['name'].split('/')[-1]) # 取最后一段做名字
                )
                self.dh_emitter.emit(prop_event)
                print(f"   ✅ [Activated] 上游节点已激活: {src_urn}")
            except Exception as e:
                print(f"   ⚠️ [Activation Failed] 激活上游节点遇到小问题 (通常可忽略): {e}")
            # =========================================================

            # 2. 将其加入上游列表
            upstream_tables.append(UpstreamClass(
                dataset=src_urn, 
                type=DatasetLineageTypeClass.TRANSFORMED
            ))

        # 3. 处理 Target (与之前逻辑一致)
        for tgt in targets:
            target_urn = f"urn:li:dataset:(urn:li:dataPlatform:{tgt['platform']},{tgt['name']},PROD)"
            print(f"   🔹 [Target URN]: {target_urn}")
            
            lineage_aspect = UpstreamLineageClass(upstreams=upstream_tables)
            
            event = MetadataChangeProposalWrapper(
                entityType="dataset",
                changeType="UPSERT",
                entityUrn=target_urn,
                aspectName="upstreamLineage",
                aspect=lineage_aspect
            )
            
            self.dh_emitter.emit(event)
            print(f"   ✅ [Lineage Sent] 成功发送血缘: {target_urn}")

    def _report_to_amundsen(self, sources, targets):
        query = """
        UNWIND $lineages AS lin
        MERGE (s:Table {key: lin.source_key})
        MERGE (t:Table {key: lin.target_key})
        MERGE (s)-[:OUTPUT]->(t)
        """
        
        lineage_data = []
        for src in sources:
            src_key = self._get_amundsen_key(src['platform'], 'default', src['name'])
            for tgt in targets:
                tgt_key = self._get_amundsen_key(tgt['platform'], 'default', tgt['name'])
                lineage_data.append({"source_key": src_key, "target_key": tgt_key})

        print(f"   📦 [Neo4j Params]: {json.dumps(lineage_data, indent=2)}")

        if lineage_data:
            with self.neo4j_driver.session() as session:
                result = session.run(query, lineages=lineage_data)
                # 获取执行摘要 (Summary)，这是最重要的“响应”信息
                summary = result.consume()
                print(f"   ✅ [Neo4j Response]: Nodes created: {summary.counters.nodes_created}, "
                      f"Relationships created: {summary.counters.relationships_created}, "
                      f"Properties set: {summary.counters.properties_set}")

    def close(self):
        if self.neo4j_driver:
            self.neo4j_driver.close()