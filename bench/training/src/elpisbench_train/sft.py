import argparse
from .common import jsonl, validate_rows

def main():
    p=argparse.ArgumentParser(); p.add_argument("data"); p.add_argument("--dry-run",action="store_true"); a=p.parse_args()
    rows=validate_rows(jsonl(a.data)); print({"trainer":"SFTTrainer","rows":len(rows),"dry_run":a.dry_run})
    if not a.dry_run: raise RuntimeError("initial ElpisBench release only authorizes dry runs; wire explicit training config before launch")
