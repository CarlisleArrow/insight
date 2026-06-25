# scripts/register_cdc_lineage.py
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) # 确保能导入 utils
from utils.lineage_reporter import LineageReporter

def register_cdc():
    reporter = LineageReporter()
    
    # 定义表映射关系 (Kafka -> MinIO RAW)
    tables = [
        "categories", "lines", "processes", 
        "analysis_records", "chemical_analysis_results"
    ]
    
    print("🚀 开始上报 CDC_RAW_Streaming 血缘...")
    
    for tbl in tables:
        # Source: Kafka
        src = [{'platform': 'kafka', 'name': f'qms.qms.{tbl}'}]
        # Target: S3/MinIO Raw
        tgt = [{'platform': 's3', 'name': f'datalake-raw/qms/{tbl}'}]
        
        reporter.report(src, tgt)
        print(f"  - Registered: Kafka({tbl}) -> RAW({tbl})")
        
    reporter.close()

if __name__ == "__main__":
    register_cdc()