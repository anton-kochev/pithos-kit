# Slicing and sequencing

Use this reference when an outcome is too large, risky, or interdependent to deliver
as one increment. Start with the accepted scope and its source, not a backlog quota.
Keep planning useful even if some slices remain blocked on decisions.

## Choose a useful representation

- **User story:** name who needs what and why. The familiar sentence template is
  optional; acceptance examples make the behavior testable. Stories are not obsolete.
- **Story map:** arrange activities and capabilities along a journey, then mark a
  release cut that supports a coherent experience. Use it alongside individual slices.
- **Job story:** “When [situation], I want [motivation], so I can [outcome]” can clarify
  context. It still needs boundaries and acceptance checks before implementation.
- **Integrated scope:** use Shape Up-style finishable parts spanning needed layers
  rather than role buckets. Revisit boundaries as dependencies become clearer;
  a finishable scope is not necessarily an independently marketable release.
- **Plain outcome, spike, enabler, or migration:** use an honest label when a story
  adds no clarity. Record the benefit or question and how completion will be judged.

These are complementary tools, not required phases or competing maturity levels.
Choose the smallest representation that makes the next decision and outcome clear.

## Find a vertical boundary

1. State the observable result and its beneficiary, including operators or API clients.
2. Trace the minimum path through inputs, rules, state changes, and outputs.
3. Split by operation, workflow step, business-rule variant, or supported data subset.
4. For each proposed cut, ask what can be demonstrated and used without unfinished
   neighboring work. Preserve essential error handling, authorization, and invariants.
5. Put implementation tasks below the outcome. Avoid treating “build schema,” “build
   endpoint,” and “build screen” as three independently valuable deliveries.

Illustration, not a repository requirement: “A customer can view their own latest
invoice” may be a thin end-to-end slice. Searching invoice history could come later
if accepted scope allows that order. Access control and preventing other customers'
data exposure belong in the first release, not a later security story.
If a schema change must precede the behavior, name it as an enabler with its own
compatibility checks and link the dependent slice; do not pretend it is user value.

Separate **out of scope**, **deferred within accepted scope**, and **unresolved**.
A smaller first release must not erase accepted requirements from the plan.
Capture representative success and failure examples, edge cases that affect safety,
and relevant nonfunctional constraints. Link shared constraints rather than copying.

## Reduce uncertainty before committing detail

Order work by consequential uncertainty as well as value and real prerequisites.
A difficult integration, migration, or operational limit may deserve early learning.
For a spike, specify the bounded question, available evidence, permitted experiment,
completion/stop condition, and which decision or slice depends on the answer.
Use only supplied or explicitly agreed effort bounds; never invent a time estimate.
Separate findings from assumptions and prototype code from releasable implementation.
If the answer invalidates the plan, revise the proposal and seek scope decisions;
do not quietly redefine acceptance criteria to make the spike look successful.

An enabler must name what it enables and an observable exit condition. A migration
must address compatibility and data integrity, not merely say “move the data.”
Avoid building a broad foundation for hypothetical future slices.

## Distinguish dependencies from release groups

For a real prerequisite, record **A before B because …; complete when …**, linked to
its source or rationale. A preference for one team to work first is not a dependency.
Check for cycles, unavailable external capabilities, unresolved contracts, and shared
state. Break cycles by changing boundaries or resolving contracts, not by hiding them.
Allow parallel work only when contracts and change ownership are clear; file paths
and work scopes are not locks, so coordinate overlaps explicitly.

Label independently releasable slices separately from merge-only increments.
Group coupled slices when users cannot safely use them alone; name the reason and
the conditions for releasing the group. Prefer smaller groups when safety permits.
For each release boundary, consider only relevant risks:
- Compatibility during mixed-version operation and partial rollout.
- Migration/backfill integrity and recovery or forward-repair strategy.
- Required authorization, privacy, validation, and failure behavior.
- Operational visibility sufficient to detect harmful outcomes and act on them.

Flags and staged rollout may help, but disabling a flag does not undo data changes.
Do not call an increment releasable until its required safeguards are accounted for.
Do not execute deployment or migration merely because the plan describes it.

## Refine only the near term

Make the next slices actionable; retain later outcomes and uncertainties at a coarser
level. Revisit sequencing after learning or scope changes. Do not invent delivery dates.
For each near-term slice, ensure linked requirements, acceptance checks, boundaries,
prerequisites, release conditions, and blockers are sufficient for the intended reader.
Readiness is not approval or proof of implementation. Record who accepted a decision
only when evidence supplies that fact; mark unknown provenance rather than guessing.
When revising, follow links to affected decisions, slices, and checks; update only the
authorized artifacts and disclose unresolved drift instead of silently resolving it.

## Optional reading

These are background, not required tooling or an authority to override accepted scope:
- [Humanizing Work: splitting user stories](https://www.humanizingwork.com/the-humanizing-work-guide-to-splitting-user-stories/)
- [Jeff Patton: story mapping and release strategies](https://jpattonassociates.com/services/story-mapping-and-release-strategies-hands-on-intensive/)
- [Intercom: job stories](https://www.intercom.com/blog/accidentally-invented-job-stories)
- [Shape Up: map the scopes](https://basecamp.com/shapeup/3.3-chapter-12)
