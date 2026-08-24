import ast
import contextlib
import io
import json
import sys
import traceback

scope = {"__name__": "__elpis_guest__", "__builtins__": __builtins__}
input_stream = sys.stdin
wire = sys.stdout
hidden_input = io.StringIO()
hidden_output = io.StringIO()
sys.stdin = hidden_input
sys.__stdin__ = hidden_input
sys.stdout = hidden_output
sys.__stdout__ = hidden_output
sys.stderr = hidden_output
sys.__stderr__ = hidden_output

def bounded(text, maximum):
    raw = text.encode("utf-8")
    if len(raw) <= maximum:
        return text, False, len(raw)
    return raw[:maximum].decode("utf-8", "ignore"), True, len(raw)

def reply(value):
    wire.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    wire.flush()

for raw in input_stream:
    try:
        request = json.loads(raw)
        if request.get("op") == "close":
            reply({"ok": True, "kind": "closed"})
            break
        if request.get("op") != "run":
            reply({"ok": False, "kind": "protocol", "failure_kind": "protocol", "error": "unsupported child operation"})
            continue
        source = request["source"]
        preview_max = int(request["preview_max_bytes"])
        tree = ast.parse(source, filename="<elpis-python>", mode="exec")
        tail = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        prefix = ast.Module(body=tree.body[:-1] if tail else tree.body, type_ignores=[])
        out = io.StringIO()
        err = io.StringIO()
        has_value = False
        value = None
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            if prefix.body:
                exec(compile(prefix, "<elpis-python>", "exec"), scope, scope)
            if tail is not None:
                value = eval(compile(ast.Expression(tail.value), "<elpis-python>", "eval"), scope, scope)
                scope["_"] = value
                has_value = True
        preview = ""
        preview_truncated = False
        preview_bytes = 0
        if has_value:
            try:
                rendered = repr(value)
            except BaseException as exc:
                rendered = f"<repr failed: {type(exc).__name__}>"
            preview, preview_truncated, preview_bytes = bounded(rendered, preview_max)
        stdout, stdout_truncated, stdout_bytes = bounded(out.getvalue(), 65536)
        stderr, stderr_truncated, stderr_bytes = bounded(err.getvalue(), 65536)
        reply({
            "ok": True,
            "kind": "completed",
            "has_value": has_value,
            "saved_as": "_" if has_value else None,
            "preview": preview,
            "preview_bytes": preview_bytes,
            "preview_truncated": preview_truncated,
            "stdout": stdout,
            "stdout_bytes": stdout_bytes,
            "stdout_truncated": stdout_truncated,
            "stderr": stderr,
            "stderr_bytes": stderr_bytes,
            "stderr_truncated": stderr_truncated,
        })
    except SyntaxError as exc:
        reply({"ok": False, "kind": "failed", "failure_kind": "preparse", "error": f"{exc.__class__.__name__}: {exc}"})
    except BaseException as exc:
        detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        reply({"ok": False, "kind": "failed", "failure_kind": "runtime", "error": detail[:4096]})
