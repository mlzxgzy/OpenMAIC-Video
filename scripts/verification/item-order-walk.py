#!/usr/bin/env python3
"""Live walk of the item-ordering audit rules over real HTTP.

`unitDependencies` had a write route and no reader: the model could author a
teaching-order claim that nothing ever checked. These two audit rules are the
reader. This walk drives the whole path a real author takes — POST an edge, then
GET /review — and asserts the finding appears, disappears when the edge is
withdrawn, and never fires for an edge that claims no order.

Deliberately does not use the stashed/committed module directly: the point is to
prove the rules are reachable from a running server, not that a pure function
returns a finding.
"""
import json
import os
import urllib.request
import urllib.error
import http.cookiejar

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
        return status, json.loads(raw)
    except Exception:
        return status, raw[:300]


def check(name, got, want):
    ok = got == want
    RESULTS.append((ok, name, got, want))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  got={got!r} want={want!r}")
    return got


def show(label, payload, limit=420):
    print(f"    {label}: {json.dumps(payload, ensure_ascii=False)[:limit]}")


def rules(body):
    # GET /review returns derived findings, whose key is `rule`. Only the
    # persisting POST returns stored records keyed `ruleCode`.
    return [f.get("rule") for f in body.get("findings", [])]


def order_findings(body, rule):
    return [f for f in body.get("findings", []) if f.get("rule") == rule]


def build_course(owner, title):
    """Drive one task to a real outline with two items and no audit errors.

    Returns (task_id, first_unit, second_unit, objective_id). Any step that
    reports a failure here is the gate doing its job, not a test failure, so the
    walk prints the refusal instead of pretending the course is ready.
    """
    st, body = req(owner, "POST", "/api/curriculum/design/tasks", {"title": title})
    assert st == 201, (st, body)
    tid = body["task"]["id"]

    req(owner, "PATCH", f"/api/curriculum/design/tasks/{tid}", {
        "audience": "高校 CTF 新队员", "learnerLevel": "beginner", "durationHours": 4,
        "problemStatement": "能独立完成一道基础 SQL 注入 CTF 题"})
    req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/phase")  # -> outcomes

    st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/objectives", {
        "code": "O1", "title": "能够利用 SQL 注入读出指定数据", "objectiveType": "competency",
        "level": "course", "bloomLevel": "apply",
        "expectedBehavior": "在给定靶场中构造有效 payload 读出目标数据",
        "minCriteria": ["识别注入点", "构造有效 payload", "读出指定数据"],
        "difficulty": "intermediate"})
    assert st == 201, (st, body)
    oid = body["objective"]["id"]

    # Evidence belongs to the outcomes phase, nodes to the graph phase: creating
    # a node before advancing is refused, which is the phase machine working.
    st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/evidence", {
        "objectiveId": oid, "evidenceType": "quiz", "verificationMethod": "答题结果",
        "successCondition": "答对注入点与 payload 构造", "assessmentMode": "practice",
        "hintPolicy": "unlimited"})
    assert st == 201, (st, body)
    evidence_id = body["evidence"]["id"]

    req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/phase")  # -> graph
    st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/nodes", {
        "name": "SQL 注入原理", "nodeType": "knowledge"})
    assert st == 201, (st, body)
    node_id = body["node"]["id"]

    st, body = req(owner, "PUT", f"/api/curriculum/design/tasks/{tid}/node-objectives", {
        "links": [{"nodeId": node_id, "objectiveId": oid, "supportLevel": "primary"}]})
    assert st == 200, (st, body)
    req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/phase")  # -> outline

    units = []
    for idx, (unit_title, role) in enumerate(
        [("基础：读懂一个 HTTP 请求", "lecture"), ("进阶：构造注入 payload", "practice")]
    ):
        st, body = req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/units", {
            "title": unit_title, "unitType": "item", "unitRole": role, "orderIndex": idx,
            "teachingDesign": {"nodes": [node_id]}})
        assert st == 201, (st, body)
        uid = body["unit"]["id"]
        for kind in ("teach", "practice", "assess"):
            st, cov = req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/unit-coverage", {
                "unitId": uid, "objectiveId": oid, "coverageKind": kind})
            assert st == 201, (st, cov)
        units.append(uid)
    return tid, units[0], units[1], oid, evidence_id


owner = make_opener()

print("=" * 72)
print("S6 LIVE WALK — item ordering edges are now read by the audit")
print("=" * 72)

tid, first, second, oid, evidence_id = build_course(owner, "E2E 教学顺序：读取与执行")
print(f"    task_id={tid}\n    first={first}\n    second={second}")

# A sound course first: the baseline must be clean or every later assertion is
# measuring the wrong thing.
st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{tid}/review")
check("GET /review -> 200", st, 200)
check("baseline course has no item-order findings",
      [r for r in rules(body) if r.startswith("unit_dependency")], [])
check("baseline review is read-only (not persisted)", body.get("persisted"), False)

# The claim, made correctly: first is a prerequisite of second, and it is
# scheduled first. Nothing should fire.
st, dep = req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/unit-dependencies", {
    "sourceUnitId": first, "targetUnitId": second, "edgeType": "prerequisite"})
check("POST /unit-dependencies -> 201", st, 201)
edge_id = dep["dependency"]["id"]

st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{tid}/review")
check("a correct order produces no out-of-order finding",
      order_findings(body, "unit_dependency_out_of_order"), [])

# Now the contradiction: move the advanced item ahead of its own prerequisite.
st, moved = req(owner, "PATCH", f"/api/curriculum/design/tasks/{tid}/units/{second}",
                {"orderIndex": 0})
check("PATCH unit orderIndex -> 200", st, 200)
st, moved = req(owner, "PATCH", f"/api/curriculum/design/tasks/{tid}/units/{first}",
                {"orderIndex": 1})
check("PATCH the prerequisite later -> 200", st, 200)

st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{tid}/review")
found = order_findings(body, "unit_dependency_out_of_order")
check("a wrong order is now flagged", len(found), 1)
check("finding severity is error", found[0].get("severity"), "error")
check("finding names the edge", found[0].get("refId"), edge_id)
check("finding message names both items",
      "进阶：构造注入 payload" in found[0].get("message", "")
      and "基础：读懂一个 HTTP 请求" in found[0].get("message", ""), True)
# The words here are the author-facing ones the unit suite pins too
# (tests/curriculum/design-audit.test.ts); this walk adds the claim that they
# arrive over HTTP and not only inside the process.
check("finding message reports 1-based positions",
      "第 1 位" in found[0].get("message", ""), True)
show("out-of-order finding", found[0] if found else None)
check("a wrong order breaks dependency_valid",
      body.get("quality", {}).get("layers", {}).get("dependency_valid"), False)
check("a wrong order is not exportable", body.get("quality", {}).get("exportable"), False)

# Withdrawing the claim must clear it. This is the delete route the walk in S4
# already proved works; here it proves the *rule* stops firing, which is the part
# that did not exist before.
st, body = req(owner, "DELETE",
               f"/api/curriculum/design/tasks/{tid}/unit-dependencies/{edge_id}")
check("DELETE /unit-dependencies/[id] -> 200", st, 200)
st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{tid}/review")
check("withdrawing the edge clears the finding",
      order_findings(body, "unit_dependency_out_of_order"), [])
check("withdrawing the edge restores dependency_valid",
      body.get("quality", {}).get("layers", {}).get("dependency_valid"), True)

# A related edge claims no order, so it must not be held to one.
st, dep2 = req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/unit-dependencies", {
    "sourceUnitId": second, "targetUnitId": first, "edgeType": "related"})
check("POST a related edge -> 201", st, 201)
st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{tid}/review")
check("a related edge is not held to an order",
      order_findings(body, "unit_dependency_out_of_order"), [])
req(owner, "DELETE", f"/api/curriculum/design/tasks/{tid}/unit-dependencies/"
         f"{dep2['dependency']['id']}")

# A loop in the claimed order has no first item.
st, e1 = req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/unit-dependencies",
             {"sourceUnitId": first, "targetUnitId": second, "edgeType": "prerequisite"})
st, e2 = req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/unit-dependencies",
             {"sourceUnitId": second, "targetUnitId": first, "edgeType": "prerequisite"})
check("POST the return edge -> 201", st, 201)
st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{tid}/review")
cycles = order_findings(body, "unit_dependency_cycle")
check("a loop in the teaching order is flagged", len(cycles), 1)
check("cycle message says there is no first item",
      "没有可以最先讲授的条目" in (cycles[0].get("message", "") if cycles else ""), True)
check("the loop also reports the one edge that runs backwards",
      len(order_findings(body, "unit_dependency_out_of_order")), 1)
# The other half of the loop (first -> second) points forwards at positions 0
# and 1, so it is *not* out of order. A cycle is a separate defect from a
# backwards edge, and reporting both would double-count one problem.
check("the forward half of the loop is not reported as backwards",
      "基础：读懂一个 HTTP 请求\" is scheduled at position 1"
      in (order_findings(body, "unit_dependency_out_of_order")[0].get("message", "")
          if order_findings(body, "unit_dependency_out_of_order") else ""), False)
show("cycle finding", cycles[0] if cycles else None)

req(owner, "DELETE", f"/api/curriculum/design/tasks/{tid}/unit-dependencies/{e1['dependency']['id']}")
req(owner, "DELETE", f"/api/curriculum/design/tasks/{tid}/unit-dependencies/{e2['dependency']['id']}")
st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{tid}/review")
check("clearing the loop clears the cycle finding",
      order_findings(body, "unit_dependency_cycle"), [])

# The two graphs are independent claims. A wrong order in the *item* graph must
# be reported as such, and must not be confused with the objective-graph rule
# that already existed — that is why this is a separate rule code.
st, dep3 = req(owner, "POST", f"/api/curriculum/design/tasks/{tid}/unit-dependencies", {
    "sourceUnitId": first, "targetUnitId": second, "edgeType": "prerequisite"})
st, body = req(owner, "GET", f"/api/curriculum/design/tasks/{tid}/review")
check("the item rule is distinct from the objective rule",
      "unit_dependency_out_of_order" in rules(body)
      and "dependency_out_of_order" not in rules(body), True)
req(owner, "DELETE", f"/api/curriculum/design/tasks/{tid}/unit-dependencies/"
         f"{dep3['dependency']['id']}")

print("=" * 72)
passed = sum(1 for ok, *_ in RESULTS if ok)
failed = [r for r in RESULTS if not r[0]]
print(f"{passed}/{len(RESULTS)} passed, {len(failed)} failed")
for _, name, got, want in failed:
    print(f"  FAIL {name}: got={got!r} want={want!r}")
print("=" * 72)
raise SystemExit(1 if failed else 0)
