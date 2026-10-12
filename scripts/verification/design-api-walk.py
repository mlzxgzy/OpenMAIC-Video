#!/usr/bin/env python3
"""Live end-to-end walk of the S4 design routes against the running dev server.

Two separate anonymous owners verify the owner fence for real; the refusals
(phase gate, cycle, chapter-with-role, empty verify rules, JSONB enum typo)
are exercised rather than only the happy path.
"""
import json
import os
import urllib.request
import urllib.error
import http.cookiejar

# Point at a fresh server when the long-running dev server is still holding
# pre-edit chunks: DESIGN_WALK_BASE=http://localhost:3100
BASE = os.environ.get("DESIGN_WALK_BASE", "http://localhost:3000")
RESULTS = []


def make_opener():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def req(opener, method, path, body=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with opener.open(r, timeout=60) as resp:
            raw = resp.read().decode()
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        status = e.code
    try:
        parsed = json.loads(raw)
    except Exception:
        parsed = raw[:300]
    return status, parsed


def check(name, got, want):
    ok = got == want
    RESULTS.append((ok, name, got, want))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  got={got!r} want={want!r}")
    return got


def show(label, payload, limit=500):
    print(f"    {label}: {json.dumps(payload, ensure_ascii=False)[:limit]}")


owner = make_opener()
stranger = make_opener()

print("=" * 72)
print("S4 LIVE WALK")
print("=" * 72)

st, body = req(owner, "POST", "/api/curriculum/design/tasks", {"title": "E2E 校验：SQL 注入"})
check("POST /tasks -> 201", st, 201)
task_id = body["task"]["id"]
check("new task starts in phase 'task'", body["task"]["designPhase"], "task")
print(f"    task_id={task_id}")

st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/phase")
check("GET /phase -> 200", st, 200)
check("next phase is 'outcomes'", body["nextPhase"], "outcomes")
check("not ready while the brief is empty", body["readyToAdvance"], False)
check("gap report is specific", len(body["gaps"]) > 0, True)
gaps = body["gaps"]
show("gaps", gaps)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
advance_refusal = body.get("error", {})
check("POST /phase with gaps -> 409", st, 409)
check("advance refusal code", advance_refusal.get("code"), "CURRICULUM_DESIGN_PHASE_LOCKED")
check("advance refusal carries both phases",
      advance_refusal.get("details"), {"current": "task", "required": "outcomes"})
# The refusal has to repeat what the phase report listed, in the words the
# author reads. It names the gap by its label ("课程简介缺少授课对象"), not by
# the column behind it — the column is a caller's identifier and lives in
# `details`, which is checked above.
check("advance refusal repeats every gap the phase report listed",
      all(gap in advance_refusal.get("message", "") for gap in gaps), True)
show("refusal", body)

# The other half of the phase machine: a write that belongs to a phase not yet
# reached. It has to be the *same* refusal shape, so a client that handles one
# case handles both, and "not finished yet" never arrives as "bad request".
st, locked_task = req(owner, "POST", "/api/curriculum/design/tasks",
                      {"title": "E2E 阶段锁"})
ltid = locked_task["task"]["id"]
st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{ltid}/objectives",
               {"code": "X", "title": "越过阶段", "objectiveType": "knowledge"})
check("write into unreached phase -> 409", st, 409)
lock_refusal = body.get("error", {})
show("phase-lock body", body)
check("phase-lock code matches the advance refusal",
      lock_refusal.get("code"), advance_refusal.get("code"))
check("phase-lock details match the advance refusal",
      lock_refusal.get("details"), advance_refusal.get("details"))

st, body = req(owner, "PATCH", f"/api/curriculum/design/tasks/{task_id}", {
    "audience": "高校 CTF 战队新队员", "learnerLevel": "beginner", "durationHours": 4,
    "problemStatement": "能独立完成一道基础 SQL 注入 CTF 题"})
check("PATCH /tasks/[id] -> 200", st, 200)

# Step 1 has a second condition. A filled-in brief is not an agreed one: the
# design may not build outcomes on a card the author has not read back.
st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/direction")
check("GET /direction -> 200", st, 200)
check("card is complete", body["gaps"], [])
check("card is not yet confirmed", body["confirmed"], False)
check("not ready while unconfirmed", body["readyToAdvance"], False)
check("phase report names the missing sign-off",
      any("课程方向还没有确认" in gap for gap in body["phaseGaps"]), True)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("advance on an unconfirmed card -> 409", st, 409)
check("refusal names the sign-off",
      "课程方向还没有确认" in body.get("error", {}).get("message", ""), True)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/direction")
check("POST /direction (confirm) -> 200", st, 200)
check("confirmation records the user", body["confirmation"]["confirmedBy"], "user")
first_confirmation = body["confirmation"]["id"]
st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/direction")
check("re-confirming replaces the row rather than stacking", body["confirmation"]["id"],
      first_confirmation)

st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/phase")
check("gaps clear once the brief is filled AND confirmed", body["gaps"], [])
check("readyToAdvance true", body["readyToAdvance"], True)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("advance task -> outcomes", st, 200)
check("phase now 'outcomes'", body["task"]["designPhase"], "outcomes")

# Editing the card afterwards re-opens the step: the signature belonged to the
# old text, and the workspace has to show the step as open again.
st, body = req(owner, "PATCH", f"/api/curriculum/design/tasks/{task_id}",
               {"problemStatement": "能独立完成两道基础 SQL 注入 CTF 题"})
check("PATCH after confirm -> 200", st, 200)
st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/direction")
check("editing the card withdraws the confirmation", body["confirmed"], False)
st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/direction")
check("re-confirm after the edit -> 200", st, 200)
st, body = req(owner, "DELETE", f"/api/curriculum/design/tasks/{task_id}/direction")
check("DELETE /direction -> 200", st, 200)
check("withdrawn", body["confirmed"], False)
st, body = req(owner, "DELETE", f"/api/curriculum/design/tasks/{task_id}/direction")
check("withdrawing twice -> 404", st, 404)
# Put it back: the rest of the walk treats this task as past step 1.
req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/direction")

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/objectives", {
    "code": "O1", "title": "能够利用 SQL 注入获取指定数据", "objectiveType": "competency",
    "level": "course", "bloomLevel": "apply",
    "expectedBehavior": "在给定靶场中构造有效 payload 读出目标数据",
    "minCriteria": ["识别注入点", "判断注入类型", "构造有效 payload", "读出指定数据"],
    "difficulty": "intermediate"})
check("POST /objectives -> 201", st, 201)
obj = body["objective"]
check("verifiable derived true (caller omitted it)", obj["verifiable"], True)
print(f"    objective_id={obj['id']}")

st, body2 = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/objectives", {
    "code": "O2", "title": "了解 SQL 注入", "objectiveType": "knowledge", "level": "course"})
check("POST vague objective -> 201", st, 201)
check("vague objective not verifiable", body2["objective"]["verifiable"], False)
obj2 = body2["objective"]

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("outcomes -> graph blocked w/o evidence -> 409", st, 409)
show("refusal", body)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/evidence", {
    "objectiveId": obj["id"], "evidenceType": "lab", "verificationMethod": "实操考试",
    "successCondition": "成功读取 /flag", "auxiliaryCondition": "出现有效注入行为",
    "assessmentMode": "exam", "hintPolicy": "forbidden", "independent": True,
    "processRecord": True, "timeLimitSec": 1200})
check("POST /evidence -> 201", st, 201)
check("exam evidence forces hints off", body["evidence"]["hintPolicy"], "forbidden")
check("exam evidence forces independent work", body["evidence"]["independent"], True)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/evidence", {
    "objectiveId": obj2["id"], "evidenceType": "quiz", "verificationMethod": "理论题",
    "successCondition": "答对 3/4", "assessmentMode": "practice", "hintPolicy": "limited"})
check("evidence for second objective -> 201", st, 201)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("advance outcomes -> graph once evidenced", st, 200)

st, b_http = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/nodes",
                 {"name": "HTTP 请求与参数", "nodeType": "knowledge", "difficulty": "intro"})
st2, b_sql = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/nodes",
                 {"name": "SQL 注入 payload 构造", "nodeType": "skill", "difficulty": "intermediate"})
check("POST /nodes x2 -> 201", (st, st2), (201, 201))
n_http, n_sql = b_http["node"]["id"], b_sql["node"]["id"]

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("orphan node blocks outline -> 409", st, 409)
show("refusal", body)

st, body = req(owner, "PUT", f"/api/curriculum/design/tasks/{task_id}/node-objectives", {
    "links": [{"nodeId": n_http, "objectiveId": obj["id"], "supportLevel": "secondary"},
              {"nodeId": n_sql, "objectiveId": obj["id"], "supportLevel": "primary"}]})
check("PUT /node-objectives -> 200", st, 200)
check("two links kept", len(body.get("links", [])) if isinstance(body, dict) else -1, 2)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/dependencies", {
    "sourceId": n_http, "targetId": n_sql, "sourceKind": "node", "targetKind": "node",
    "edgeType": "prerequisite", "strength": 0.9})
check("POST /dependencies -> 201", st, 201)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/dependencies", {
    "sourceId": n_sql, "targetId": n_http, "sourceKind": "node", "targetKind": "node",
    "edgeType": "prerequisite"})
check("cycle refused", st in (400, 409), True)
show("cycle refusal", body)

# the graph is now fully linked, so the outline may be entered
st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/phase")
check("graph gaps clear after linking", body["gaps"], [])
st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("advance graph -> outline", st, 200)

# a unit written before the outline phase is locked out (checked above for
# objectives; here the outline itself must be the gate for units)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/units",
               {"unitType": "chapter", "title": "第一章 SQL 注入"})
check("POST chapter -> 201", st, 201)
chap = body["unit"]["id"]

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/units",
               {"unitType": "chapter", "title": "越权章", "unitRole": "lecture"})
check("chapter with unitRole -> 400", st, 400)
show("chapter-role refusal", body)

st, b_lec = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/units",
                {"unitType": "item", "title": "1.1 SQL 注入原理", "unitRole": "lecture", "chapterId": chap})
st2, b_pra = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/units",
                 {"unitType": "item", "title": "1.2 SQL 注入练习", "unitRole": "practice", "chapterId": chap})
st3, b_exa = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/units",
                 {"unitType": "item", "title": "1.3 SQL 注入实战", "unitRole": "exam", "chapterId": chap})
check("POST items lecture/practice/exam -> 201", (st, st2, st3), (201, 201, 201))
u_lec, u_pra, u_exa = b_lec["unit"]["id"], b_pra["unit"]["id"], b_exa["unit"]["id"]

# A teaching-order claim is a row, not a field, and POST is an upsert: it can
# restate a claim but never withdraw it. Without DELETE, a wrong order recorded
# here could only be undone by deleting the whole task.
st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/unit-dependencies",
               {"sourceUnitId": u_lec, "targetUnitId": u_pra, "edgeType": "prerequisite"})
check("POST /unit-dependencies -> 201", st, 201)
udep = body["dependency"]["id"]
st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/unit-dependencies",
               {"sourceUnitId": u_lec, "targetUnitId": u_pra, "edgeType": "prerequisite",
                "strength": 0.4})
check("re-recording the same edge -> 201 (upsert)", st, 201)
st, snap = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}")
check("upsert kept a single edge", len(snap["unitDependencies"]), 1)

st, body = req(stranger, "DELETE",
               f"/api/curriculum/design/tasks/{task_id}/unit-dependencies/{udep}")
check("stranger DELETE unit dependency -> 404", st, 404)

st, body = req(owner, "DELETE",
               f"/api/curriculum/design/tasks/{task_id}/unit-dependencies/{udep}")
check("DELETE /unit-dependencies/[id] -> 200", st, 200)
check("delete returns deleted:true", body.get("deleted"), True)
st, snap = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}")
check("edge is gone from the snapshot", snap["unitDependencies"], [])
st, body = req(owner, "DELETE",
               f"/api/curriculum/design/tasks/{task_id}/unit-dependencies/{udep}")
check("deleting it twice -> 404, not a silent success", st, 404)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("outline -> teaching blocked until taught -> 409", st, 409)
show("teaching gate", body)

for kind, unit in (("teach", u_lec), ("practice", u_pra), ("assess", u_exa)):
    st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/unit-coverage",
                   {"unitId": unit, "objectiveId": obj["id"], "coverageKind": kind, "depth": "standard"})
    check(f"coverage {kind} recorded -> 201", st, 201)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/unit-coverage",
               {"unitId": u_lec, "objectiveId": obj2["id"], "coverageKind": "teach"})
check("coverage for second objective -> 201", st, 201)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("teaching phase reachable", st, 200)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
# The assessment boundary re-checks teaching, not assessment material: an
# outcome may still be authored while the task sits in `teaching`, and this is
# what stops exam authoring starting on top of an outcome nothing teaches.
check("teaching -> assessment passes once every outcome is taught", st, 200)

# give the second outcome the same three-row closure so the loop can close
for kind, unit in (("practice", u_pra), ("assess", u_exa)):
    st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/unit-coverage",
                   {"unitId": unit, "objectiveId": obj2["id"], "coverageKind": kind})
    check(f"coverage {kind} for objective 2 -> 201", st, 201)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("assessment phase reachable", st, 200)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/questions", {
    "unitId": u_exa, "objectiveId": obj["id"], "questionType": "single",
    "stem": "下列哪段 payload 最可能触发错误型注入？",
    "options": [{"key": "A", "text": "1' AND 1=1-- -"}, {"key": "B", "text": "1'"}],
    "answer": ["B"], "explanation": "未闭合引号会破坏原查询结构", "difficulty": "intermediate"})
check("POST /questions -> 201", st, 201)
if st != 201:
    show("question refusal", body)
print(f"    question_id={body['question']['id']}")

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/lab-tasks", {
    "unitId": u_exa, "objectiveId": obj["id"], "taskGoal": "读取 /flag",
    "dockerImage": "ctf/sqli-lab:1.0",
    "referenceSolution": [{"step": 1, "action": "发现注入点"}, {"step": 2, "action": "读取 /flag"}],
    "verifyRules": []})
check("lab with no verifyRules refused", st in (400, 409), True)
show("refusal", body)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/lab-tasks", {
    "unitId": u_exa, "objectiveId": obj["id"], "taskGoal": "读取 /flag",
    "dockerImage": "ctf/sqli-lab:1.0", "verifyRules": [{"kind": "flg", "value": "/flag"}]})
check("JSONB enum typo -> 400", st, 400)
show("typo refusal", body)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/lab-tasks", {
    "unitId": u_exa, "objectiveId": obj["id"], "taskGoal": "读取 /flag",
    "dockerImage": "ctf/sqli-lab:1.0", "containerConfig": {"port": 8080},
    "referenceSolution": [{"step": 1, "action": "发现注入点"},
                          {"step": 2, "action": "构造 payload 读取 /flag"}],
    "verifyRules": [{"kind": "flag", "value": "flag{e2e}"}], "scoringMode": "result"})
check("lab with result verify rule -> 201", st, 201)
check("reference solution kept separate", len(body["labTask"]["referenceSolution"]), 2)

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("review phase reachable", st, 200)

st1, r1 = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/review")
st2, r2 = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/review")
check("GET /review -> 200 twice", (st1, st2), (200, 200))
check("GET /review is pure (identical)", r1 == r2, True)
check("GET /review writes nothing", r1.get("persisted"), False)
show("review summary", {k: v for k, v in r1.items() if not isinstance(v, list)})

st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{task_id}/review")
check("POST /review -> 200", st, 200)
check("POST /review persists", body.get("persisted"), True)
findings = body.get("findings", [])
check("findings carry ids", all("id" in f for f in findings) if findings else True, True)
print(f"    persisted findings: {len(findings)}")

st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/findings")
print(f"    >>> GET /findings (collection): status={st} (no collection route exists)")
check("no findings collection route; snapshot carries them instead", st, 404)

st, snap_now = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}")
audit = snap_now.get("auditFindings", [])
check("snapshot exposes persisted findings", len(audit) > 0, True)
check("persisted findings carry ids", all("id" in f for f in audit) if audit else False, True)
print(f"    auditFindings in snapshot: {len(audit)}")
if audit:
    f0 = audit[0]
    st, body = req(owner, "PATCH",
                   f"/api/curriculum/design/tasks/{task_id}/findings/{f0['id']}",
                   {"status": "waived"})
    check("PATCH finding status -> 200", st, 200)

st, cov = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/coverage")
check("GET /coverage -> 200", st, 200)
show("coverage verdict", {k: v for k, v in cov.items() if not isinstance(v, list)})

st, tr = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/trace?objectiveId={obj['id']}")
check("trace objective -> course -> 200", st, 200)
show("forward trace keys", list(tr.get("trace", {}).keys()))

st, tr = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/trace?unitId={u_exa}")
check("trace unit -> outcomes -> 200", st, 200)
show("backward trace keys", list(tr.get("trace", {}).keys()))

st, tr = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/trace")
check("trace with no arg -> 400", st, 400)

st, gate = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}/export-gate")
check("GET /export-gate -> 200", st, 200)
check("export blocked while loop open", gate.get("exportable"), False)
show("gate blockers", gate.get("blockers", gate))

st, body = req(stranger, "GET", f"/api/curriculum/design/tasks/{task_id}")
check("stranger GET task -> 404", st, 404)
st, body = req(stranger, "DELETE", f"/api/curriculum/design/tasks/{task_id}")
check("stranger DELETE task -> 404", st, 404)
st, body = req(stranger, "POST", f"/api/curriculum/design/tasks/{task_id}/phase")
check("stranger advance phase -> 404", st, 404)
st, body = req(stranger, "GET", "/api/curriculum/design/tasks")
check("stranger sees no tasks", body.get("tasks"), [])

# The sign-off is owner-scoped like every other route: a guessed task id must not
# let a stranger confirm or un-confirm someone else's course.
st, body = req(stranger, "GET", f"/api/curriculum/design/tasks/{task_id}/direction")
check("stranger GET direction -> 404", st, 404)
st, body = req(stranger, "POST", f"/api/curriculum/design/tasks/{task_id}/direction")
check("stranger confirm -> 404", st, 404)
st, body = req(stranger, "DELETE", f"/api/curriculum/design/tasks/{task_id}/direction")
check("stranger withdraw -> 404", st, 404)

# ── Step 1 as a conversation, against the real model ────────────────────────
# The answer is model-dependent, so this pins the pipeline rather than the
# wording: the turn writes the card, only the seven known slots come back, and
# the button path can then close the step. A deployment with no model configured
# is reported as a skip, not as a failure.
print()
print("-" * 72)
print("STEP 1 CONVERSATION (live model)")
st, body = req(owner, "POST", "/api/curriculum/design/direction", {
    "instruction": "给大二信息安全专业学生上一门 CTF 综合实战课，48 学时，"
                   "范围是 6 个方向各 3 个案例，只做 slide 理论与 Docker 实操",
})
if st == 400 and body.get("error", {}).get("code") == "MISSING_MODEL":
    print("SKIP  no language model configured for the design slot")
else:
    check("POST /direction -> 200", st, 200)
    check("model answered with a message", len(body.get("message", "")) > 0, True)
    show("model message", body.get("message", ""), 300)
    ai_task = body.get("task")
    check("the turn created a task row", ai_task is not None, True)
    known = {"title", "audience", "learnerLevel", "trainingScenario",
             "durationHours", "applicationScene", "problemStatement"}
    check("card carries only the seven known slots",
          set(body.get("values", {}).keys()) - known, set())
    if ai_task:
        print(f"    ai task_id={ai_task['id']}")
        # Whatever the model left out, the author fills in; the button then
        # closes the step and the phase machine opens.
        st, state = req(owner, "GET", f"/api/curriculum/design/tasks/{ai_task['id']}/direction")
        fill = {}
        if state.get("values", {}).get("audience") is None:
            fill["audience"] = "大二信息安全专业学生"
        if state.get("values", {}).get("problemStatement") is None:
            fill["problemStatement"] = "6 方向 × 3 案例，只做 slide 理论与 Docker 实操"
        if state.get("values", {}).get("durationHours") is None:
            fill["durationHours"] = 48
        if fill:
            req(owner, "PATCH", f"/api/curriculum/design/tasks/{ai_task['id']}", fill)
        st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{ai_task['id']}/direction")
        check("the card can then be confirmed -> 200", st, 200)
        st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{ai_task['id']}/phase")
        check("a conversation-built course can leave step 1", st, 200)

st, snap = req(owner, "GET", f"/api/curriculum/design/tasks/{task_id}")
check("GET snapshot -> 200", st, 200)
counts = {k: len(v) for k, v in snap.items() if isinstance(v, list)}
print(f"    snapshot collections: {counts}")
for needed in ("objectives", "evidence", "nodes", "units"):
    check(f"snapshot carries {needed}", needed in snap, True)

print()
print("=" * 72)
failed = [r for r in RESULTS if not r[0]]
print(f"TOTAL {len(RESULTS)}  PASS {len(RESULTS) - len(failed)}  FAIL {len(failed)}")
for ok, name, got, want in failed:
    print(f"  - {name}: got={got!r} want={want!r}")
print(f"TASK_ID={task_id}")
print("=" * 72)
raise SystemExit(1 if failed else 0)
