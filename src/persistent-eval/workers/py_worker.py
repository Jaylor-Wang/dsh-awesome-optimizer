#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
py_worker.py - Zero-dependency persistent Python worker for DSH Agent.
Maintains a stateful global scope across execution frames over stdio line-delimited JSON.
"""

import sys
import io
import os
import ast
import json
import time
import traceback
import math
import re
import collections
import itertools

# Ensure strict UTF-8 stdio streams with line buffering
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

# Keep handles to original standard streams for JSON protocol frames
REAL_STDIN = sys.__stdin__
REAL_STDOUT = sys.__stdout__

def create_fresh_scope():
    return {
        "__name__": "__main__",
        "__doc__": "DSH Persistent Python Kernel",
        "__builtins__": __builtins__,
        "math": math,
        "re": re,
        "json": json,
        "time": time,
        "collections": collections,
        "itertools": itertools,
    }

GLOBAL_SCOPE = create_fresh_scope()

def execute_code(code, scope):
    """
    Execute python code.
    If the last AST node is an expression, evaluate it to capture its return value.
    Otherwise execute as statements.
    """
    code_stripped = code.strip()
    if not code_stripped:
        return None

    parsed = ast.parse(code, filename="<eval_kernel>", mode="exec")
    if not parsed.body:
        return None

    # Check if the last statement is an expression
    last_stmt = parsed.body[-1]
    if isinstance(last_stmt, ast.Expr):
        # If there are preceding statements, execute them first
        if len(parsed.body) > 1:
            exec_mod = ast.Module(body=parsed.body[:-1], type_ignores=[])
            exec(compile(exec_mod, filename="<eval_kernel>", mode="exec"), scope)

        # Evaluate the trailing expression
        eval_expr = ast.Expression(body=last_stmt.value)
        return eval(compile(eval_expr, filename="<eval_kernel>", mode="eval"), scope)
    else:
        # All statements, execute directly
        exec(compile(parsed, filename="<eval_kernel>", mode="exec"), scope)
        return None

def serialize_result(result):
    if result is None:
        return None, None
    if isinstance(result, float):
        rounded = round(result, 10)
        if abs(result - rounded) < 1e-12:
            result_repr = str(rounded)
        else:
            result_repr = repr(result)
    else:
        result_repr = repr(result)
    try:
        # Check if directly JSON-serializable
        json.dumps(result)
        return result, result_repr
    except (TypeError, OverflowError):
        # Fall back to string representation
        return result_repr, result_repr

def main():
    global GLOBAL_SCOPE

    # Signal ready frame on startup
    ready_frame = json.dumps({"status": "ready", "pid": os.getpid()}, ensure_ascii=False) + "\n"
    REAL_STDOUT.buffer.write(ready_frame.encode("utf-8"))
    REAL_STDOUT.buffer.flush()

    for line in REAL_STDIN:
        line_str = line.strip()
        if not line_str:
            continue

        try:
            req = json.loads(line_str)
        except Exception as e:
            err_frame = json.dumps({
                "id": None,
                "success": False,
                "error": f"Invalid JSON payload: {str(e)}",
                "stdout": "",
                "stderr": "",
                "executionTimeMs": 0
            }, ensure_ascii=False) + "\n"
            REAL_STDOUT.buffer.write(err_frame.encode("utf-8"))
            REAL_STDOUT.buffer.flush()
            continue

        req_id = req.get("id")
        action = req.get("action", "eval")
        code = req.get("code", "")
        should_reset = bool(req.get("reset", False))

        if action == "ping":
            resp = {
                "id": req_id,
                "success": True,
                "status": "pong",
                "pid": os.getpid()
            }
            frame = json.dumps(resp, ensure_ascii=False) + "\n"
            REAL_STDOUT.buffer.write(frame.encode("utf-8"))
            REAL_STDOUT.buffer.flush()
            continue

        if action == "reset" or should_reset:
            GLOBAL_SCOPE = create_fresh_scope()
            if action == "reset":
                resp = {
                    "id": req_id,
                    "success": True,
                    "stdout": "",
                    "stderr": "",
                    "result": "Kernel namespace reset successfully.",
                    "executionTimeMs": 0
                }
                frame = json.dumps(resp, ensure_ascii=False) + "\n"
                REAL_STDOUT.buffer.write(frame.encode("utf-8"))
                REAL_STDOUT.buffer.flush()
                continue

        captured_stdout = io.StringIO()
        captured_stderr = io.StringIO()
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        sys.stdout = captured_stdout
        sys.stderr = captured_stderr

        start_time = time.perf_counter()
        success = True
        error_msg = None
        result_val = None
        result_repr = None

        try:
            raw_result = execute_code(code, GLOBAL_SCOPE)
            result_val, result_repr = serialize_result(raw_result)
        except Exception as ex:
            success = False
            error_msg = str(ex)
            # Write traceback into captured_stderr
            traceback.print_exc(file=captured_stderr)
        finally:
            elapsed_ms = round((time.perf_counter() - start_time) * 1000, 3)
            sys.stdout = old_stdout
            sys.stderr = old_stderr

        resp = {
            "id": req_id,
            "success": success,
            "stdout": captured_stdout.getvalue(),
            "stderr": captured_stderr.getvalue(),
            "result": result_val,
            "resultRepr": result_repr,
            "error": error_msg,
            "executionTimeMs": elapsed_ms
        }

        frame = json.dumps(resp, ensure_ascii=False) + "\n"
        REAL_STDOUT.buffer.write(frame.encode("utf-8"))
        REAL_STDOUT.buffer.flush()

if __name__ == "__main__":
    main()
