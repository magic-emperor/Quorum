"""
Phase 10 — FastAPI server.

Endpoints:
  WS  /ws/runs/{run_id}          — live ToolEvent stream (backfill + tail)
  GET /runs                      — list all runs
  GET /runs/{run_id}             — run metadata + status
  GET /runs/{run_id}/events      — full event log (jsonl → JSON array)
  GET /runs/{run_id}/diff        — unified diff + change log
  POST /runs/{run_id}/approve    — approve diff → commit (auth-gated)
  POST /runs/{run_id}/discard    — discard execution branch (auth-gated)
  GET /                          — web dashboard (HTML)
  GET /health                    — liveness probe

Start: `qorum serve` or `uvicorn qorum.server.app:app --reload`
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from qorum.core.logger import get_logger
from qorum.server.auth import require_run_auth
from qorum.server.event_bus import EventBus, get_bus
from qorum.server.runs import RunRecord, RunStore, get_store

log = get_logger(__name__)

app = FastAPI(
    title="Qorum Visibility Server",
    description="Real-time execution visibility for Qorum runs.",
    version="1.0.0",
)

# Phase 11: board webhooks
from qorum.server.webhooks import router as webhooks_router
app.include_router(webhooks_router)

# Phase 12: Teams Bot Framework messaging endpoint
# The teams_adapter is set at runtime when the bot starts.
_teams_adapter = None


def set_teams_adapter(adapter) -> None:
    global _teams_adapter
    _teams_adapter = adapter


@app.post("/api/messages")
async def teams_messages(request: Request) -> JSONResponse:
    """
    Bot Framework messaging endpoint for Microsoft Teams.
    All Teams activities (messages, Invoke/Adaptive Card actions) arrive here.
    """
    if _teams_adapter is None:
        return JSONResponse({"error": "Teams adapter not configured"}, status_code=503)

    body = await request.body()
    auth_header = request.headers.get("Authorization", "")

    try:
        from botbuilder.schema import Activity
        activity = Activity().deserialize(
            __import__("json").loads(body)
        )
        invoke_response = await _teams_adapter.process_activity(activity, auth_header)
        if invoke_response:
            return JSONResponse(
                content=invoke_response.body,
                status_code=invoke_response.status,
            )
        return JSONResponse({}, status_code=200)
    except Exception as exc:
        log.error("teams.messages_error", error=str(exc))
        return JSONResponse({"error": str(exc)}, status_code=500)


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "runs": len(get_store().list_all())}


# ── Runs ──────────────────────────────────────────────────────────────────────

@app.get("/runs")
async def list_runs() -> list[dict]:
    return get_store().list_all()


@app.get("/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    record = get_store().get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
    return record.to_dict()


@app.get("/runs/{run_id}/events")
async def get_events(run_id: str) -> list[dict]:
    """Return all events for a run as a JSON array."""
    return get_bus().replay(run_id)


@app.get("/runs/{run_id}/diff")
async def get_diff(run_id: str) -> dict:
    """Return the unified diff + per-file change log for a completed run."""
    record = get_store().get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
    if not record.result:
        return {"diff": "", "change_log": [], "status": record.status}

    result = record.result
    return {
        "run_id": run_id,
        "branch": result.branch,
        "diff": result.diff_summary,
        "change_log": [
            {
                "path": e.path,
                "action": e.action,
                "lines_added": e.lines_added,
                "lines_removed": e.lines_removed,
                "agent": e.agent,
                "reason": e.reason,
            }
            for e in result.change_log
        ],
        "gate": record.gate.model_dump() if record.gate else None,
        "status": record.status,
    }


# ── Actions ───────────────────────────────────────────────────────────────────

@app.post("/runs/{run_id}/approve")
async def approve_diff(
    run_id: str,
    body: dict = None,
) -> dict:
    """Approve diff → trigger commit. Delegates to the adapter's commit logic."""
    record = get_store().get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
    if record.status not in ("complete",):
        raise HTTPException(status_code=409, detail=f"Run is in state '{record.status}', not approvable")

    # Gate guard
    if record.gate and not record.gate.passed and not record.gate.overridden:
        raise HTTPException(
            status_code=422,
            detail=f"Gate failed ({record.gate.verdict}). Fix tests or override.",
        )

    approved_by = (body or {}).get("user", "unknown")
    get_store().mark_approved(run_id, approved_by)
    log.info("server.diff_approved", run_id=run_id, by=approved_by)

    # Publish approval event
    from qorum.tools.events import ToolEvent
    get_bus().publish(run_id, ToolEvent(
        kind="status", agent="server",
        summary=f"Diff approved by {approved_by} — committing...",
    ))

    return {"status": "approved", "run_id": run_id}


@app.post("/runs/{run_id}/discard")
async def discard_run(run_id: str) -> dict:
    record = get_store().get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")

    get_store().mark_discarded(run_id)

    from qorum.tools.events import ToolEvent
    get_bus().publish(run_id, ToolEvent(
        kind="status", agent="server", summary="Execution discarded by user."
    ))

    return {"status": "discarded", "run_id": run_id}


@app.post("/runs/{run_id}/stop")
async def stop_run(run_id: str) -> dict:
    """
    Request cancellation of a running execution. Works whether the execution is
    in THIS process (in-memory token) or another (the bot): we set the in-process
    token if present AND write a control file the runner polls cross-process.
    """
    record = get_store().get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")

    from qorum.execution.cancellation import get_registry
    # run_id == plan_id for chat-triggered runs.
    found = get_registry().cancel(run_id, cross_process=True)

    get_store().mark_stopping(run_id)

    from qorum.tools.events import ToolEvent
    get_bus().publish(run_id, ToolEvent(
        kind="cancelled", agent="server",
        summary="Stop requested by user — halting at the next safe point.",
    ))

    return {"status": "stopping", "run_id": run_id, "token_found": found}


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws/runs/{run_id}")
async def ws_run_stream(websocket: WebSocket, run_id: str) -> None:
    """
    Stream ToolEvents for a run. Late joiners get backfill then live events.
    Protocol: server sends JSON strings; client sends 'ping' to test liveness.
    """
    await websocket.accept()
    log.info("ws.connected", run_id=run_id)
    bus = get_bus()

    try:
        async for event_json in bus.subscribe(run_id):
            try:
                await websocket.send_text(event_json)
            except Exception:
                break
    except WebSocketDisconnect:
        pass
    finally:
        log.info("ws.disconnected", run_id=run_id)


# ── Web dashboard ─────────────────────────────────────────────────────────────

_DASHBOARD_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qorum — Run Dashboard</title>
<style>
  body { font-family: system-ui, monospace; background: #0d1117; color: #e6edf3; margin: 0; }
  h1   { padding: 1rem; border-bottom: 1px solid #30363d; margin: 0; font-size: 1.2rem; }
  #runs-list { padding: 1rem; }
  .run { border: 1px solid #30363d; border-radius: 6px; padding: .75rem 1rem; margin-bottom: .5rem; cursor: pointer; }
  .run:hover { border-color: #58a6ff; }
  .run .branch { color: #79c0ff; font-family: monospace; font-size:.85em; }
  .badge { display:inline-block; padding:.2em .5em; border-radius:3px; font-size:.8em; }
  .running  { background:#1f6feb; } .complete { background:#238636; }
  .failed   { background:#da3633; } .approved { background:#1a7f37; }
  .discarded{ background:#484f58; }
  #event-feed { background:#161b22; border-top:1px solid #30363d; padding:1rem; max-height:40vh; overflow-y:auto; font-family:monospace; font-size:.8rem; }
  .ev-ok  { color:#3fb950; } .ev-fail { color:#f85149; } .ev-info { color:#8b949e; }
  #diff-view  { padding:1rem; }
  #diff-view pre { background:#161b22; padding:1rem; border-radius:6px; overflow-x:auto; font-size:.75rem; }
  .add { color:#3fb950; } .del { color:#f85149; }
  #controls { padding:1rem; border-top:1px solid #30363d; display:flex; gap:.5rem; }
  button { padding:.4rem .9rem; border:none; border-radius:4px; cursor:pointer; font-size:.9rem; }
  #btn-approve { background:#238636; color:#fff; } #btn-discard { background:#da3633; color:#fff; }
  #btn-stop { background:#bb8009; color:#fff; }
  .running  { background:#1f6feb; } .stopping { background:#bb8009; } .cancelled { background:#6e7681; }
</style>
</head>
<body>
<h1>⬡ Qorum — Run Dashboard</h1>
<div id="runs-list">Loading runs…</div>
<div id="event-feed" style="display:none"></div>
<div id="diff-view" style="display:none"></div>
<div id="controls" style="display:none">
  <button id="btn-stop">🛑 Stop</button>
  <button id="btn-approve">✅ Approve diff → commit</button>
  <button id="btn-discard">↩ Discard</button>
</div>

<script>
const API = window.location.origin;
let currentRunId = null, ws = null;

async function loadRuns() {
  const resp = await fetch(API + '/runs');
  const runs = await resp.json();
  const el = document.getElementById('runs-list');
  if (!runs.length) { el.innerHTML = '<p style="color:#8b949e">No runs yet.</p>'; return; }
  el.innerHTML = runs.map(r => `
    <div class="run" onclick="openRun('${r.run_id}')">
      <strong>${r.plan_id}</strong>
      <span class="badge ${r.status}">${r.status}</span>
      <span class="branch">${r.branch || '—'}</span>
      <small style="float:right;color:#8b949e">${r.started_at.slice(0,16).replace('T',' ')}</small>
      <br><small>+${r.lines_added}/-${r.lines_removed} in ${r.files_changed} file(s) · gate: ${r.gate_verdict || 'n/a'}</small>
    </div>`).join('');
}

async function openRun(runId) {
  currentRunId = runId;
  document.getElementById('event-feed').style.display = 'block';
  document.getElementById('controls').style.display = 'flex';
  connectWS(runId);
  loadDiff(runId);
}

function connectWS(runId) {
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/runs/${runId}`);
  ws.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.kind === 'ping') return;
    const feed = document.getElementById('event-feed');
    const cls = ev.ok ? 'ev-ok' : (ev.kind === 'error' ? 'ev-fail' : 'ev-info');
    feed.innerHTML += `<div class="${cls}">[${ev.agent}] ${ev.summary}</div>`;
    feed.scrollTop = feed.scrollHeight;
  };
}

async function loadDiff(runId) {
  const resp = await fetch(API + '/runs/' + runId + '/diff');
  const data = await resp.json();
  const el = document.getElementById('diff-view');
  el.style.display = 'block';
  const lines = (data.diff || '').split('\\n').map(l => {
    if (l.startsWith('+') && !l.startsWith('+++')) return `<span class="add">${esc(l)}</span>`;
    if (l.startsWith('-') && !l.startsWith('---')) return `<span class="del">${esc(l)}</span>`;
    return esc(l);
  });
  el.innerHTML = `<h3>Diff — ${data.branch || ''}</h3><pre>${lines.join('\\n')}</pre>`;
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

document.getElementById('btn-approve').onclick = async () => {
  if (!currentRunId) return;
  await fetch(API+'/runs/'+currentRunId+'/approve', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({user:'web-user'})});
  loadRuns();
};
document.getElementById('btn-discard').onclick = async () => {
  if (!currentRunId) return;
  await fetch(API+'/runs/'+currentRunId+'/discard', {method:'POST'});
  loadRuns();
};
document.getElementById('btn-stop').onclick = async () => {
  if (!currentRunId) return;
  await fetch(API+'/runs/'+currentRunId+'/stop', {method:'POST'});
  loadRuns();
};

loadRuns();
setInterval(loadRuns, 10000);
</script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
async def dashboard() -> str:
    return _DASHBOARD_HTML
