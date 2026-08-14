import json, subprocess

class TypeScriptRolloutBridge:
    """Drive grouped candidates through the Docker-only TypeScript runner."""
    def __init__(self, cli=("npm","run","bench","--")):
        self.cli=tuple(cli)
    def rollout(self, scenario: str, candidates: list[str], fake=False):
        payload=json.dumps({"scenario":scenario,"candidates":candidates,"fake":fake})
        proc=subprocess.run([*self.cli,"data","rollout","--stdin"],input=payload,text=True,capture_output=True,check=True)
        return json.loads(proc.stdout)
