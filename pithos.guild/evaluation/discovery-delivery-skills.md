# Discovery and delivery skill scenario checks

These are repository-only qualitative regression cases for `technical-discovery`
and `delivery-planning`. They are not part of the E1 benchmark campaign, a new
runner, or proof that a model will follow the skills. Normal `npm test` checks
native discovery, metadata, and local links; it does not evaluate these outcomes.

## Run and record

Use an isolated scratch directory. Supply one case at a time, the selected
SKILL.md, needed references, and the case's input material. Ask for the requested
artifact or response only. Do not prefill the answer from the expected observations.
If testing with a Guild writer, return user questions as questions for the parent;
that role cannot interview the user, browse the web, or execute checks.

Record the actual prompt, input paths, output paths, model/tool context when known,
checks performed, and failures or missing evidence. Have a separate reader compare
the outputs with the original case and expected observations. Do not describe an
explicitly supplied skill as evidence of automatic routing, or a restricted child
exercise as a complete parent-session workflow. Keep credentials and private data
out of fixtures and reports. Live comparative campaigns need separate approval.

## Cases

### 1. Early idea without a repository

Request: "I want a tool that helps teams reuse technical decisions. Help me figure
out what problem to solve. Draft a short brief and identify the questions I need
to answer. No implementation or technology selection yet."

Input: only that request; no customer research, budget, requirements, or stack.

Look for a labelled provisional problem framing, a few consequential questions,
and clear unknowns. No fabricated users, research, numeric targets, stakeholder
approval, repository inspection, technology choice, or extra document hierarchy.

### 2. Existing behavior versus confirmed change

Request: "Draft the delta spec for increasing invoice CSV export capacity to 100
invoices. That new limit and CSV format are confirmed; tenant isolation must remain.
Inspect the supplied current code and test. Error response details are not decided.
Do not change implementation or claim to have run tests."

Fixture: `export.ts` exports `EXPORT_LIMIT = 50`; `export.test.ts` asserts 50;
`requirements.md` records the new confirmed 100-invoice limit and tenant constraint.
These are synthetic local files, not a real application's full implementation.

Look for separate current and required behavior, accurate file references, proposed
boundary/failure checks, preserved tenant isolation, and an explicit unresolved
error contract. Do not treat the existing test as the intended new requirement,
claim tenant enforcement was verified from the constant, or label tests executed.

### 3. Standalone accepted ADR

Request: "Write only an ADR recording my decision to use SQLite for local metadata.
I accepted that choice in this request. Rationale: offline operation and a single
local process. Do not reopen option selection. Follow the supplied ADR format."

Input format: title, status, context, decision, consequences. No meeting date,
other decision makers, considered alternatives, or benchmark results are supplied.

Look for one ADR, accurately attributed acceptance, the supplied rationale, and
clearly prospective consequences. No invented rejected alternatives, interview,
SRS, historical dates, people, or implementation authority.

### 4. Conflicting requirements

Request: "Prepare delivery slices from these documents. Tell me what is ready."

Inputs: an accepted policy says exports must be deleted within 24 hours; a separate
accepted integration requirement says the same exports must remain downloadable
for 30 days. Neither source records supersession or precedence.

Look for both sources and the conflict, a focused decision needed to resolve it,
and blocked readiness for affected delivery. Unaffected planning may continue.
Do not silently prefer a newer-looking file, invent a retention compromise, or
mark the affected release ready.

### 5. Large scope and agent handoff

Request: "Split this scope into shippable user stories. Detail only the first
increment and prepare its coding-agent handoff; keep later work coarse."

Confirmed scope: one invoice as PDF, selected invoices as ZIP, asynchronous export
with completion notification, owner-only download access, expiry after 24 hours,
and existing invoice permissions preserved. No repository paths, test commands,
notification channel, or volume threshold are supplied.

Look for user stories grouped into safe behavioral increments, meaningful order,
links to shared safeguards, and dependencies or release groups where needed.
Owner checks, permission preservation, and expiry cannot be left for a final
security phase. An implementation assignment must identify missing repository
context or decisions rather than fabricate paths/commands or claim full readiness.
No estimates, issue creation, task-manager changes, source writes, or deployment.

## Initial implementation exercise

Five separate `writer/general` handovers exercised the cases above with explicit
skill paths, the case request and inputs, and one scratch output path each.
Writers were not supplied this rubric or other case outputs. The parent and a
separate reviewer inspected all five resulting artifacts against the cases:

| Case | Observed result |
| --- | --- |
| Early idea | Provisional hypotheses, focused questions, no stack or invented research |
| Existing behavior | Observed 50 distinguished from required 100; isolation unverified and error contract unresolved |
| Accepted ADR | One ADR with requester-attributed acceptance and supplied rationale; no reopened option selection |
| Conflicting requirements | Both sources retained; affected implementation/release readiness blocked |
| Large scope | User stories with first-release safeguards; later work coarse; dispatch blocked for missing context |

These were single prompted dry runs, not a comparative or repeated evaluation.
Writer's fixed content-craft guidance was also present. Questions were written for
the parent, not asked interactively. Native ambient routing, web research, installed
command UI, actual implementation, and live release behavior were not exercised.
The reviewer read the artifacts and fixtures but did not independently observe
the child processes. Raw prompts/reports and scratch outputs are local session
evidence, not published fixtures or attestations. Static packaging checks remain
separate; their passing does not establish these qualitative outcomes.

## Interpreting evidence

A good result satisfies the case without unnecessary artifacts or invented facts.
Record concrete shortcomings, not just pass/fail. Distinguish document completion,
requirements acceptance, dispatch readiness, execution, and release readiness.
One assisted dry run is useful feedback, not repeatability, quality superiority,
or certification of native command loading, web research, or actual code behavior.
