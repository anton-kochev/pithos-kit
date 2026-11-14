# Review and maintenance of technical artifacts

Review against the original need and actual evidence, not just whether a template
is filled in. Scope the review: one ADR, a requirements document, a connected set
of artifacts, or a change against existing contracts. A broad review isn't
required for a small editorial update.

## Questions that reveal useful gaps

- Does this solve the stated problem for the intended people or systems?
- Are goals, non-goals, constraints, and requirement sources identifiable?
- Which claims are observed, supplied, inferred, proposed, disputed, or unknown?
- Are acceptance criteria observable, and do they include relevant failure cases?
- Are options evaluated against the real constraints rather than a preferred stack?
- Are decision status and acceptance provenance honest?
- Does the design meet the requirements, including cross-cutting safeguards?
- Can each planned slice be demonstrated and safely released, or is its release
  dependency explicitly stated?
- Are contracts, names, IDs, and links consistent across the affected documents?
- Are migration, security, privacy, compatibility, and operational risks visible?
- Is there duplication that will drift, unnecessary process, or unrequested scope?

Propose concrete corrections with source references. Distinguish a missing
requirement decision from a writing defect. Do not infer that the code is wrong
from a draft spec, or that a spec is right because the code follows it.

## Independent scrutiny when warranted

For consequential changes, an independent reader can challenge both the original
assumptions and proposed solution. Guild's reviewer has a fixed eligibility gate:
use it only for a code/change review connected to substantive repository source,
which may include related documentation. It is not a general document-review role.
Keep early-idea briefs, standalone SRSs without connected code, and other ineligible
document scrutiny in the parent using the checklist above; do not manufacture an
implementation review or relax the child's gate to obtain a second opinion.

For an eligible handover, give the reviewer the original request, user constraints
and decisions with provenance, exact artifact paths and comparison, relevant source
material, and actual verification evidence and limitations. Children do not inherit
prior discussion; instruct them to read the supplied files. Keep implementer
assumptions separate from user decisions. The existing
[review standards](../../code-review-standards/SKILL.md) govern that review.

Close material context gaps before calling a review complete. A reviewer cannot
prove stakeholder approval, requirements validity, or system behavior through
text inspection alone. Resolve supported findings; don't manufacture objections
or additional documents just to make review look thorough.

## Separate kinds of verification

State exactly what happened:
- **Inspected:** source, document, or supplied log examined, with scope.
- **Executed:** command, environment, result, and relevant output actually observed.
- **Proposed:** a check to run later, not a completed verification.
- **Unavailable:** missing evidence/tool/access, and what conclusion it prevents.

Link checking and schema validation establish mechanical properties, not quality
of requirements or correctness of a decision. Examples, reviewer assertions,
checkboxes, and generated traceability tables are not proof that software passes.
Never claim tests, benchmarks, builds, user validation, or compliance checks ran
unless they actually did. Do not execute code just to validate prose without
appropriate authorization and tool permissions.

## Update without erasing history

When a requirement or decision changes, find affected designs, contracts, slices,
acceptance criteria, and test plans. Update the authorized scope and report the
remaining impact. Don't regenerate a document tree blindly or overwrite manual
edits. Preserve stable IDs and links when possible. Accepted historical decisions
should be superseded, not rewritten as if the past agreement never happened.

Identify which documents describe current requirements, which are proposals, and
which are historical. Note review triggers or ownership when known; don't assign
people or invent schedules. End with artifact paths, substantive changes,
remaining blockers, and verification limits. A draft's completion, approval,
implementation, and release are separate states.

## Background

[Birgitta Böckeler's October 2025 analysis](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)
raises document overload, maintenance, and false-confidence risks. Treat it as a
historical analysis, not a current verdict on the tools it reviewed. The useful
lesson here is to keep artifacts proportional and verification explicit.
