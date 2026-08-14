import argparse
from .common import jsonl

def main():
    p=argparse.ArgumentParser(); p.add_argument("data"); p.add_argument("--dry-run",action="store_true"); a=p.parse_args(); rows=jsonl(a.data)
    for row in rows:
        assert row.get("chosen") and row.get("rejected") and row["chosen"] != row["rejected"]
    print({"trainer":"DPOTrainer","pairs":len(rows),"dry_run":a.dry_run})
    if not a.dry_run: raise RuntimeError("initial ElpisBench release only authorizes dry runs")
