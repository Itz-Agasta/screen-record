#!/usr/bin/env python3
"""
backend/scripts/smoke_user_side_api.py

User-side API smoke test against a running backend instance.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE_URL = os.getenv("SMOKE_BASE_URL", "http://127.0.0.1:8010")
ADMIN_USERNAME = os.getenv("SMOKE_ADMIN_USERNAME", "superadmin")
ADMIN_PASSWORD = os.getenv("SMOKE_ADMIN_PASSWORD", "admin123")
USER_PASSWORD = os.getenv("SMOKE_USER_PASSWORD", "Userpass123")


def request_json(method: str, path: str, payload: dict | None = None, token: str | None = None) -> dict:
    data = None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(f"{BASE_URL}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"{method} {path} -> HTTP {exc.code}: {body}") from exc


def main() -> int:
    suffix = str(int(time.time()))
    username = f"smokeuser{suffix}"
    email = f"smokeuser{suffix}@example.com"

    admin_login = request_json("POST", "/auth/login", {"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
    admin_token = admin_login.get("access_token")
    if not admin_token:
        raise RuntimeError("Admin login failed: missing token")

    created_user = request_json(
        "POST",
        "/admin/users",
        {
            "username": username,
            "email": email,
            "password": USER_PASSWORD,
            "permitted_sessions": 1,
        },
        token=admin_token,
    )

    session_plan = {
        "version": 1,
        "active_session_slot": 1,
        "session_plans": [
            {
                "slot": 1,
                "state": "permitted",
                "job_name": "QA Engineer",
                "resume_text": "Test resume",
                "job_description": "Test JD",
                "prompt": "Answer briefly",
            }
        ],
    }

    request_json(
        "PATCH",
        f"/admin/users/{created_user['id']}",
        {"custom_prompt": json.dumps(session_plan)},
        token=admin_token,
    )

    user_login = request_json("POST", "/auth/login", {"username": username, "password": USER_PASSWORD})
    user_token = user_login.get("access_token")
    if not user_token:
        raise RuntimeError("User login failed: missing token")

    me = request_json("GET", "/users/me", token=user_token)
    status_before = request_json("GET", "/users/me/session-status", token=user_token)
    start_resp = request_json("POST", "/users/me/session/start", {}, token=user_token)
    respond_resp = request_json(
        "POST",
        "/users/me/session/respond",
        {
            "utterance": "hello there",
            "history": ["Interviewer: welcome"],
        },
        token=user_token,
    )
    end_resp = request_json(
        "POST",
        "/users/me/session/end",
        {"transcript": []},
        token=user_token,
    )
    status_after = request_json("GET", "/users/me/session-status", token=user_token)

    result = {
        "user_created": username,
        "me_username": me.get("username"),
        "status_before_remaining": status_before.get("sessions_remaining"),
        "start_allowed": start_resp.get("allowed"),
        "respond_should_respond": respond_resp.get("should_respond"),
        "respond_answer_len": len((respond_resp.get("answer") or "")),
        "end_summary_len": len((end_resp.get("summary") or "")),
        "status_after_used": status_after.get("used_sessions"),
        "status_after_remaining": status_after.get("sessions_remaining"),
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover
        print(f"SMOKE_TEST_FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
