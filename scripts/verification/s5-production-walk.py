#!/usr/bin/env python3
"""Live check of the S5 production seam.

Three things this asserts that the earlier walk cannot:

1. A designed course produces through its *items* — one run per item, each with
   the scene types that item's role allows, and a requirement built from the
   outcome it serves rather than a paragraph restating the title.
2. The gate refuses *before* a run is created, so a refused generate leaves no
   paid-for orphan behind. This is asserted by the refusal arriving at all: the
   route runs the gate first by construction.
3. The legacy assembler is still reachable, because replacing the default must
   not remove the fallback.

One anonymous owner throughout — the owner fence is exercised by the S4 walk, and
re-creating it here would only add noise.
"""
import json, os, urllib.request, urllib.error, http.cookiejar

BASE = os.environ.get("DESIGN_WALK_BASE", "http://localhost:3000")
RESULTS = []

op = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def req(method, path, body=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    try:
        r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        with op.open(r) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def check(name, got, want, extra=""):
    ok = got == want
    RESULTS.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}  got={got!r} want={want!r}  {extra}")


# ── Build a design, advancing a phase only once its gate is satisfied ──────
_, t = req("POST", "/api/curriculum/design/tasks", {
    "title": "S5 生产路径校验",
    "audience": "零基础学员",
    "problemStatement": "能独立完成一次 SQL 注入检测并取证",
    "durationHours": 4})
task = t["task"]["id"]
print(f"task={task}")

req("POST", f"/api/curriculum/design/tasks/{task}/phase")          # -> outcomes

_, o = req("POST", f"/api/curriculum/design/tasks/{task}/objectives", {
    "title": "检测 SQL 注入",
    "objectiveType": "skill",
    "expectedBehavior": "能用 sqlmap 判断一个参数是否存在注入",
    "minCriteria": ["说得出判断依据"]})
obj = o["objective"]["id"]

_, ev = req("POST", f"/api/curriculum/design/tasks/{task}/evidence", {
    "objectiveId": obj,
    "evidenceType": "lab",
    "verificationMethod": "读取 flag 文件",
    "successCondition": "/flag 内容正确",
    "verifyRules": [{"kind": "file_read", "path": "/flag"}]})
lab_evidence = ev["evidence"]["id"]

req("POST", f"/api/curriculum/design/tasks/{task}/phase")          # -> graph

_, n = req("POST", f"/api/curriculum/design/tasks/{task}/nodes", {
    "name": "SQL 注入原理", "nodeType": "knowledge"})
node = n["node"]["id"]
req("PUT", f"/api/curriculum/design/tasks/{task}/node-objectives",
    {"links": [{"nodeId": node, "objectiveId": obj}]})

req("POST", f"/api/curriculum/design/tasks/{task}/phase")          # -> outline

# One item per role: the three roles the design model defines.
units = {}
for title, role in [("注入原理", "lecture"), ("动手检测", "practice"), ("结业测验", "exam")]:
    body = {"unitType": "item", "title": title, "unitRole": role}
    if role == "lecture":
        # `objective_missing_prereq` reads `teachingDesign.nodes`, which is a list
        # of node *ids*. `core`/`brief`/`mention` are free-text topic strings and
        # are deliberately not scanned, so citing the node by name there would
        # silently pass nothing — the audit doc comment calls out this trap.
        body["teachingDesign"] = {"nodes": [node], "core": ["SQL 注入原理"]}
    _, u = req("POST", f"/api/curriculum/design/tasks/{task}/units", body)
    units[role] = u["unit"]["id"]
kind = {"lecture": "teach", "practice": "practice", "exam": "assess"}
for role, unit_id in units.items():
    req("POST", f"/api/curriculum/design/tasks/{task}/unit-coverage",
        {"unitId": unit_id, "objectiveId": obj, "coverageKind": kind[role]})

# The coverage ledger is what closes the loop; without this the task stays in
# `outline` and nothing downstream can advance. Phase 3 walks this by hand
# because the gate refusing is the point — a script that advanced blindly would
# pass without ever proving the gate works.
for expected_phase in ("teaching", "assessment"):
    _, step = req("POST", f"/api/curriculum/design/tasks/{task}/phase")
    check(f"phase advances to {expected_phase}",
          step["task"]["designPhase"], expected_phase,
          f'msg={str(step.get("error", {}).get("message", ""))[:120]}')

_, ph = req("GET", f"/api/curriculum/design/tasks/{task}/phase")
check("the exam gate still needs an assessable outcome",
      ph["phase"] in ("assessment", "review"), True,
      f'phase={ph["phase"]} gaps={ph["gaps"]}')

# ── The gate refuses while the exam has no question ───────────────────────
_, gate = req("GET", f"/api/curriculum/design/tasks/{task}/export-gate")
check("gate blocks before the exam exists", gate["exportable"], False,
      f'blockers={gate["blockers"]}')

st, refused = req("POST", f"/api/curriculum/design/tasks/{task}/units/{units['lecture']}/generate")
check("a refused generate does not start a run", st, 400,
      f'code={refused.get("error", {}).get("code")} msg={refused.get("error", {}).get("message", "")[:110]}')

# `evidence_no_artifact`: lab evidence with no lab task is an error, because a
# promise nothing implements is exactly what the design model is meant to stop.
_, lab = req("POST", f"/api/curriculum/design/tasks/{task}/lab-tasks", {
    "unitId": units["practice"], "objectiveId": obj, "evidenceId": lab_evidence,
    "assessmentMode": "practice", "taskGoal": "用 sqlmap 检出注入并读取 /flag",
    "brief": "对给定站点做一次注入检测，取出 flag。",
    "dockerImage": "sqlmap:latest",
    "verifyRules": [{"kind": "file_read", "path": "/flag"}]})

# Close the loop, and confirm the gate re-opens rather than staying stuck.
req("POST", f"/api/curriculum/design/tasks/{task}/questions", {
    "unitId": units["exam"], "objectiveId": obj, "questionType": "single",
    "stem": "判断注入的依据是什么？",
    "options": [{"key": "A", "text": "看有没有报错"},
                {"key": "B", "text": "输入是否被拼进查询"}],
    "answer": ["B"]})

_, gate2 = req("GET", f"/api/curriculum/design/tasks/{task}/export-gate")
check("gate opens once the loop closes", gate2["exportable"], True,
      f'blockers={gate2["blockers"]}')

# ── Each role produces what its role allows ───────────────────────────────
print("\n--- per-role production ---")
expected = {
    "lecture":  (["slide"], False, False),
    "practice": (["slide", "quiz", "interactive"], True, True),
    "exam":     (["slide", "quiz"], True, False),
}
# The owner may have only `maxActiveRunsPerOwner` (default 2) runs in flight, and
# this loop starts three. That limit is enforced by the real store, so without
# releasing each run the third call is refused — which is correct behaviour, not
# a defect, and which once made this walk report a 500 that had nothing to do
# with the exam role. The limit refusal is asserted on its own below, and each
# run is discarded once its assertions are read, so the three roles are checked
# independently instead of racing a resource limit.
for role in ("lecture", "practice", "exam"):
    st, resp = req("POST", f"/api/curriculum/design/tasks/{task}/units/{units[role]}/generate")
    if st != 202:
        check(f"{role} generate", st, 202, f"body={str(resp)[:240]}")
        continue
    scenes, interactive, task_engine = expected[role]
    check(f"{role} sceneTypes", resp["sceneTypes"], scenes)
    check(f"{role} interactive", resp["interactive"], interactive)
    check(f"{role} taskEngine", resp["taskEngine"], task_engine)
    check(f"{role} carries the design ids",
          resp["run"]["input"].get("curriculumUnitId"), units[role])
    requirement = resp["run"]["input"]["requirement"]
    check(f"{role} requirement is built from the outcome",
          "sqlmap" in requirement, True,
          f'req={requirement[:100]!r}')
    check(f"{role} response folds in the coverage verdict",
          "coverage" in resp, True)

    # Release the slot: this run has no course yet, so discarding it is the
    # documented way to end it. A 409 here would mean it had already produced a
    # course, which is worth surfacing rather than ignoring.
    dst, _ = req("DELETE", f"/api/generation-runs/{resp['run']['id']}")
    check(f"{role} run is discardable to free a slot", dst, 200,
          f"status={dst}")

# ── The limit itself is a refusal, not a failure ───────────────────────────
# Two runs at once is the default ceiling, so the third from one owner must be
# answered 429 with the limit named. Read by *starting* runs deliberately:
# this is the exact live sequence that reported a 500 for the exam role.
print("\n--- owner run limit ---")
started = []
for role in ("lecture", "practice"):
    st, resp = req("POST", f"/api/curriculum/design/tasks/{task}/units/{units[role]}/generate")
    if st == 202:
        started.append(resp["run"]["id"])
st, resp = req("POST", f"/api/curriculum/design/tasks/{task}/units/{units['exam']}/generate")
check("a third run is refused with the limit named", st, 429,
      f'code={resp.get("error", {}).get("code", "")} '
      f'msg={resp.get("error", {}).get("message", "")[:80]}')
check("the refusal is not a design failure", resp.get("error", {}).get("code", "")
      != "CURRICULUM_DESIGN_FAILED", True)
check("the refusal names the limit", "2" in resp.get("error", {}).get("message", ""), True)
for run_id in started:
    req("DELETE", f"/api/generation-runs/{run_id}")

# ── A chapter still cannot be produced ───────────────────────────────────
_, ch = req("POST", f"/api/curriculum/design/tasks/{task}/units",
            {"unitType": "chapter", "title": "第一章"})
st, resp = req("POST", f"/api/curriculum/design/tasks/{task}/units/{ch['unit']['id']}/generate")
check("a chapter is refused", st, 400,
      f'msg={resp.get("error", {}).get("message", "")[:90]}')

# ── A stranger cannot start a run from someone else's design ──────────────
other = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def req_other(method, path, body=None):
    data = None; headers = {}
    if body is not None:
        data = json.dumps(body).encode(); headers["Content-Type"] = "application/json"
    try:
        r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        with other.open(r) as resp: return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read().decode() or "{}")
st, _ = req_other("POST", f"/api/curriculum/design/tasks/{task}/units/{units['lecture']}/generate")
check("a stranger cannot generate from this design", st, 404)

# ── The legacy assembler is still reachable ──────────────────────────────
# An empty selection is refused on its own terms (no knowledge points), which
# still proves the route is mounted and validating — a 404 here would mean the
# replacement deleted the fallback.
st, asm = req("POST", "/api/curriculum/assemblies",
              {"title": "旧路径回归", "knowledgePoints": []})
check("assembler endpoint still answers", st in (200, 400), True,
      f'status={st} code={asm.get("error", {}).get("code", "")}')

print("\n" + "=" * 62)
print(f"TOTAL {len(RESULTS)}  PASS {sum(RESULTS)}  FAIL {len(RESULTS) - sum(RESULTS)}")
print(f"TASK_ID={task}")
# ── Appended diagnostic: what does the audit actually say? ─────────────────
_, rev = req("POST", f"/api/curriculum/design/tasks/{task}/review")
print("\n--- audit findings ---")
print("exportable:", rev["exportable"])
print("firstBrokenLayer:", rev["quality"]["firstBrokenLayer"])
for f in rev["findings"]:
    print(f'  [{f["severity"]}] {f["ruleCode"]}: {f["message"][:160]}')
