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
import pathlib
import difflib
import csv

# Ensure strict UTF-8 stdio streams with line buffering
if isinstance(sys.stdin, io.TextIOWrapper):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if isinstance(sys.stdout, io.TextIOWrapper):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
if isinstance(sys.stderr, io.TextIOWrapper):
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
        "pathlib": pathlib,
        "difflib": difflib,
        "csv": csv,
        "CWD": os.getcwd(),
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

    parsed = compile(code, filename="<eval_kernel>", mode="exec", flags=ast.PyCF_ONLY_AST)
    assert isinstance(parsed, ast.Module)
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

class BoundedTextCapture(io.TextIOBase):
    """Capture UTF-8 output without retaining more than the configured byte limit."""
    def __init__(self, max_bytes, label):
        self.max_bytes = max(0, int(max_bytes))
        self.label = label
        self.value = ''
        self.truncated = False

    def write(self, text):
        if self.truncated:
            return len(text)
        text = str(text)
        candidate = self.value + text
        if len(candidate.encode('utf-8')) <= self.max_bytes:
            self.value = candidate
            return len(text)
        suffix = f"\n\n[Output truncated: {self.label} exceeded {self.max_bytes} bytes.]"
        if len(suffix.encode('utf-8')) >= self.max_bytes:
            suffix = "\n[Output truncated]"
        suffix_bytes = len(suffix.encode('utf-8'))
        available = max(0, self.max_bytes - len(self.value.encode('utf-8')) - suffix_bytes)
        encoded = text.encode('utf-8')[:available]
        while encoded and (encoded[-1] & 0xc0) == 0x80:
            encoded = encoded[:-1]
        self.value += encoded.decode('utf-8', errors='ignore')
        if len((self.value + suffix).encode('utf-8')) <= self.max_bytes:
            self.value += suffix
        else:
            encoded_value = self.value.encode('utf-8')[:self.max_bytes]
            while encoded_value and (encoded_value[-1] & 0xc0) == 0x80:
                encoded_value = encoded_value[:-1]
            self.value = encoded_value.decode('utf-8', errors='ignore')
        self.truncated = True
        return len(text)

    def getvalue(self):
        return self.value


def print_user_traceback(ex, stream):
    """Hide worker frames without discarding user frames or exception metadata."""
    diagnostic = traceback.TracebackException.from_exception(ex)
    pending = [diagnostic]
    seen = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        current.stack = traceback.StackSummary.from_list(
            frame for frame in current.stack if frame.filename != __file__
        )
        for linked in (current.__cause__, current.__context__):
            if linked is not None:
                pending.append(linked)
        pending.extend(getattr(current, "exceptions", None) or [])
    diagnostic.print(file=stream)


def main():
    global GLOBAL_SCOPE
    assert REAL_STDIN is not None and REAL_STDOUT is not None, "Worker requires stdio pipes"

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

        max_output_bytes = req.get("maxOutputBytes", 8192)
        if not isinstance(max_output_bytes, int) or max_output_bytes < 0:
            max_output_bytes = 8192
        captured_stdout = BoundedTextCapture(max_output_bytes, "stdout")
        captured_stderr = BoundedTextCapture(max_output_bytes, "stderr")
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
            if "cwd" in req:
                cwd = req["cwd"]
                if not isinstance(cwd, str) or not os.path.isabs(cwd):
                    raise ValueError("cwd must be an absolute directory path")
                os.chdir(cwd)
            if action == "reset" or should_reset:
                GLOBAL_SCOPE = create_fresh_scope()
            GLOBAL_SCOPE["CWD"] = os.getcwd()
            if action == "reset":
                result_val = "Kernel namespace reset successfully."
            else:
                raw_result = execute_code(code, GLOBAL_SCOPE)
                result_val, result_repr = serialize_result(raw_result)
        except Exception as ex:
            success = False
            error_msg = str(ex)
            print_user_traceback(ex, captured_stderr)
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
