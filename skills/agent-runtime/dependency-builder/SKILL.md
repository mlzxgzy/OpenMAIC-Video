---
name: dependency-builder
title: "依赖图构建"
description: Phase 4 of outcome-first course design. Builds the learning dependency graph — which knowledge and skills must come before which, and which outcomes depend on which — checks it for cycles and for outcomes stranded without prerequisites, and repairs what it finds. Use after knowledge-decomposition, when the nodes exist but nothing says what order or what rests on what. Produces dependency edges. Not for turning the graph into chapters.
---

# Learning dependency graph

## Phase lock

You are in **phase 4 (graph)**. Nodes and their outcome links exist; you are
adding the edges. You may also add nodes — **but only to fix a gap this phase
found**, never to reorganise the substrate wholesale. That belongs to
`knowledge-decomposition`.

## This is a DAG, not a table of contents

The graph is the course's real structure. The chapter list is a *rendering* of
it, produced later. A dependency graph has properties a table of contents
cannot have, and they are the reason this phase exists:

- one node depends on several others — 「SQL 注入 Payload 构造」 needs injection
  detection, HTTP parameters and SQL execution, all three;
- one node serves several outcomes — HTTP fundamentals backs half the course;
- several nodes compose into one capability — 信息收集 + 漏洞识别 + 工具使用
  together make 「独立完成基础 Web CTF」.

That is why this is a graph and not a tree. A tree would force an ordering
that does not exist.

## Choosing the edge type

`create_dependency` takes `sourceKind`/`targetKind` (`objective` or `node`) and
an `edgeType`. The type is not decoration — the review uses it to tell a real
dependency from a decorative one.

| Edge | Means | Direction |
|---|---|---|
| `prerequisite` | must be learned first | base → advanced |
| `derives` | the outcome is decomposed from this node | node → outcome |
| `supports` | this node backs this outcome | node → outcome |
| `practices` | this drill trains that skill | drill → skill |
| `composes` | these parts form that whole | parts → whole |
| `progresses` | the next level up | lower → higher |

`derives` and `supports` overlap on purpose: `supports` is the general case and
`derives` marks the node the outcome was decomposed from. When in doubt use
`supports`.

**Direction is the thing people get wrong.** `create_dependency` takes
`sourceId` as the prerequisite and `targetId` as the thing that depends on it —
source is always first, always earlier. A reversed pair is a graph that reads
backwards and orders the course backwards.

## Cycles are refused, and that is not enough

The store refuses an edge that would close a cycle, so a loop can never be
written. A cycle-free graph is not automatically a good one, though. Two
defects survive a clean cycle check:

**An outcome with no prerequisites at all.** Not a cycle — an absence. Usually
it means a substrate was never created: 「能够利用 SQL 注入」 with no edge back
to SQL fundamentals is a promise the course cannot keep. **The fix is to add
the missing node**, not to note the gap. An outcome that needs knowledge nobody
has written down is a design hole, and it will surface as a lecture that
assumes things it never taught.

**A prerequisite that is not itself reachable.** A is fine, B depends on A, C
depends on B — but if nothing ever reaches A, the chain starts in mid-air.
Trace each chain back to a node with no prerequisites; those are the entry
points, and there should be few of them.

## Method

1. `get_course_design` — read the nodes and the outcomes.
2. For each node, ask **"what must the learner already have?"** and add
   `prerequisite` edges. Do this for the advanced nodes first; the foundation
   nodes have none, and asking them is a fast way to waste effort.
3. For each outcome, add `supports` (or `derives`) edges from the nodes that
   carry it — these should agree with what `set_node_objectives` already says.
4. Where a node composes into a capability, add `composes` edges.
5. Run `review_course_design`. Read every `dependency` finding before moving
   on. Each one names a concrete gap, and each is fixable here.
6. `advance_course_design_phase` when no node supports no outcome — that is
   the gate, and it is the only one.

## Reading the result

`get_course_design` prints each node with what it serves and what it requires.
A healthy graph looks like a broad base of prerequisites that narrows toward a
few independent capabilities. Two shapes mean something is wrong:

- **a wide middle with a thin top** — many nodes, few outcomes reached. The
  course is teaching more than it promises.
- **a long chain with nothing branching** — the course is one sequence, and
  every learner is held to the same pace. Sometimes that is what was asked for;
  when it is not, it usually means outcomes were decomposed into steps rather
  than competencies.

Do not build the chapters from this phase. That is `outline-designer`, and its
job is to make this graph teachable — which is a different question from making
it correct.
