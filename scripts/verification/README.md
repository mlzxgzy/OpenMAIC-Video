# Live verification harnesses

These are the checks that answer questions a unit test cannot: what a person
sees in a real browser, and what the HTTP API actually answers. They are *not*
run in CI — several need Chromium, and all of them need a running dev server:

```bash
pnpm dev                                     # http://localhost:3000
node scripts/verification/ux-course-walk.mjs # a browser walk
python3 scripts/verification/design-api-walk.py   # an HTTP walk
```

Chromium comes from `@playwright/test`; each harness falls back to a system
Chrome if the bundled browser will not launch.

## Side effects

Every run mints a **fresh anonymous owner** and creates its own series, courses
and design tasks under it. Nothing reads or writes the owner your browser is
using, so a walk can run while you work in the app. The data it leaves behind is
throwaway; the dev database accumulates it.

Screenshots, console logs and full run output go to `artifacts/`, which is
gitignored: it is evidence for a review, regenerable by re-running the harness,
not source.

## What each one answers

| Harness | The question |
|---|---|
| `design-api-walk.py` | Do the design routes behave over real HTTP — phases, both refusal paths, ownership, the snapshot? |
| `design-workbench-walk.mjs` | Does the design workbench work in a browser — do the two halves agree, do the gates open when the phase advances? |
| `item-order-walk.py` | Do the item-ordering audit rules fire on the order a course actually declares, and go quiet when the edge is withdrawn? |
| `lab-task-walk.mjs` | Can a hands-on task be authored in a browser, and does the exam rule refuse a lazy one with a reason a person can act on? |
| `message-language-walk.mjs` | Does the API answer a person in Chinese and a caller in identifiers, on the wire? |
| `prose-only-check.mjs` | Did a prose-only pass change only prose? Reads the working tree and a git revision; needs no server. Declare a deliberate structural edit as `path=reason`. |
| `s5-production-walk.py` | Does a closed design start a generation run, and does an open one refuse? |
| `ux-course-walk.mjs` | Can a person get from an empty workspace to a course with something in every step? |
| `ux-design-walk.mjs` | Can a person get from the design list into the first authoring step? |
| `ux-probe-gate.mjs` | Does the knowledge-relation form explain itself when both ends are the same point? |

## Exit codes

A harness that only prints `FAIL` cannot gate anything, so the ones that can fail
their own run exit non-zero: `design-api-walk.py`, `design-workbench-walk.mjs`,
`item-order-walk.py`, `lab-task-walk.mjs`, `message-language-walk.mjs`,
`prose-only-check.mjs`.

These four report and exit 0 — they are probes whose output a human reads:
`s5-production-walk.py`, `ux-course-walk.mjs`, `ux-design-walk.mjs`,
`ux-probe-gate.mjs`.

An exit code is not decoration. `design-api-walk.py` asserted a stale refusal
contract for the whole localization pass and nobody noticed, because it printed
`FAIL` and exited 0; the moment it could fail, it did.

## When a message changes

These harnesses assert the words a person reads, so a pass that rewrites messages
can leave them asserting text that no longer exists — and, being outside the test
suite, nothing runs them to find out. Translating the design and audit messages
left exactly two of them stale: `design-api-walk.py` (a refusal that named the
`audience` column) and `item-order-walk.py` (two findings still quoted in
English). Both are fixed, and both now assert the same phrases the unit suite
pins in `tests/curriculum/design-audit.test.ts`.

So after changing any author-facing message, re-run these. It is the one check
that no `pnpm test` will do for you.

## Not here

`ux-recon.mjs`, `tmp-english.mjs` and `design-render-check.mjs` stay on disk but
are gitignored: each was a one-off exploration superseded by a walk or a test
(see the comment in `.gitignore`).
