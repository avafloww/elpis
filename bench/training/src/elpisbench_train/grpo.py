import argparse
from .bridge import TypeScriptRolloutBridge

def reward(run):
    gates=run["gates"]
    if not all(gates.values()): return 0.0
    metrics=run["metrics"]
    efficiency=max(0.0,1.0-0.05*metrics["surplusModelTurns"]-0.1*metrics["failedCalls"])
    mechanical=run.get("mechanical",1.0); judged=run.get("judged",1.0)
    return 0.6*mechanical+0.2*efficiency+0.2*judged

def main():
    p=argparse.ArgumentParser(); p.add_argument("scenario"); p.add_argument("--groups",type=int,default=2); p.add_argument("--dry-run",action="store_true"); p.add_argument("--fake-service",action="store_true"); a=p.parse_args()
    if not a.dry_run: raise RuntimeError("initial ElpisBench release only authorizes dry runs")
    candidates=[f"candidate-{i}" for i in range(a.groups)]
    if a.fake_service:
        runs=[{"gates":{"outcome":True,"targeting":True,"containment":True,"terminalEnd":True,"bounded":True,"quiescent":True},"metrics":{"surplusModelTurns":i,"failedCalls":0}} for i in range(a.groups)]
    else: runs=TypeScriptRolloutBridge().rollout(a.scenario,candidates)
    print({"trainer":"GRPOTrainer","groups":len(runs),"rewards":[reward(r) for r in runs],"dry_run":True})
