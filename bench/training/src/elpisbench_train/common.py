import json
from pathlib import Path

RUN_TOOL = {"type":"function","function":{"name":"run","description":"Execute JavaScript in the persistent Elpis sandbox.","parameters":{"type":"object","properties":{"code":{"type":"string"},"end":{"type":"boolean"}},"required":["code"],"additionalProperties":False}}}

def jsonl(path: str):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]

def validate_rows(rows):
    for row in rows:
        assert row.get("messages"), "row has no messages"
        assert row.get("tools") == [RUN_TOOL], "export must contain only the canonical run tool"
        for message in row["messages"]:
            for call in message.get("tool_calls", []):
                assert isinstance(call["function"]["arguments"], dict), "tool arguments must be objects"
    return rows

class AssistantOnlyCollator:
    """Fallback when a tokenizer template lacks `{% generation %}` masks.

    The model-local assistant prefix is explicit; labels before its last
    occurrence are set to -100, so only the completion is trained.
    """
    def __init__(self, tokenizer, assistant_prefix: str):
        self.tokenizer=tokenizer
        self.prefix=tokenizer(assistant_prefix,add_special_tokens=False).input_ids
    def __call__(self, features):
        batch=self.tokenizer.pad(features,return_tensors="pt")
        labels=batch["input_ids"].clone()
        for row in labels:
            start=-1
            for i in range(0,len(row)-len(self.prefix)+1):
                if row[i:i+len(self.prefix)].tolist()==self.prefix: start=i+len(self.prefix)
            if start<0: raise ValueError("assistant prefix absent; supply the correct model-local prefix/template")
            row[:start]=-100
        batch["labels"]=labels
        return batch
