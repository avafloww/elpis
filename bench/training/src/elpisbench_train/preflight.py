import argparse
from transformers import AutoTokenizer
from .common import RUN_TOOL

GOLDEN = [
    {"role":"user","content":"Write 17 to answer.txt."},
    {"role":"assistant","content":"","tool_calls":[{"id":"call-1","type":"function","function":{"name":"run","arguments":{"code":"fs.writeFileSync('answer.txt','17')","end":True}}}]},
    {"role":"tool","tool_call_id":"call-1","content":"[run ok]"},
]

def preflight(model: str, template: str | None = None):
    tokenizer = AutoTokenizer.from_pretrained(model)
    if template:
        tokenizer.chat_template = open(template).read()
    if not tokenizer.chat_template:
        raise RuntimeError("model has no chat template; supply an explicit model-local Jinja template")
    first = tokenizer.apply_chat_template(GOLDEN[:1], tools=[RUN_TOOL], tokenize=False, add_generation_prompt=True)
    rendered = tokenizer.apply_chat_template(GOLDEN, tools=[RUN_TOOL], tokenize=False, add_generation_prompt=False)
    if not rendered.startswith(first.removesuffix(tokenizer.eos_token or "")):
        raise RuntimeError("chat-template prefix is not stable across turns")
    for needle in ("run", "answer.txt", "call-1", "[run ok]"):
        if needle not in rendered:
            raise RuntimeError(f"chat template dropped {needle!r}")
    ids = tokenizer(rendered, add_special_tokens=False).input_ids
    decoded = tokenizer.decode(ids, skip_special_tokens=False)
    if "answer.txt" not in decoded or "[run ok]" not in decoded:
        raise RuntimeError("golden trajectory failed render/tokenize/decode replay")
    supports_mask = "{% generation %}" in tokenizer.chat_template
    return {"rendered_chars":len(rendered),"tokens":len(ids),"assistant_mask":supports_mask,"custom_collator_required":not supports_mask,"fallback_collator":"AssistantOnlyCollator" if not supports_mask else None}

def main():
    p=argparse.ArgumentParser(); p.add_argument("model"); p.add_argument("--template"); a=p.parse_args()
    print(preflight(a.model,a.template))
