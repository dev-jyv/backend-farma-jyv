# Section recipes

How to fill each placeholder in `SPEC.template.md`. These are Socratic prompts, not
code-detection heuristics — a spec usually precedes the code, so there is nothing to
autodiscover. Ask the questions below, push back on one-word or vague answers, and do
not move on to the next placeholder until the current one is concrete.

The header placeholders (`{{SPEC_NUMBER}}`, `{{SPEC_TITLE}}`, `{{STATUS}}`,
`{{DEPENDS_ON}}`, `{{DATE}}`, `{{OBJECTIVE}}`) are mechanical — numbering, status
transitions, and dependency resolution — and are not covered here.

A section marked **MANDATORY** below must always render, even when the honest
answer is "doesn't apply": write `N/A — <one-line reason>` rather than leaving the
heading with nothing under it, so a reviewer can tell "skipped on purpose" from
"forgotten". A section marked **OPTIONAL** is dropped entirely — heading and
placeholder both — when its skip rule applies.

---

## `{{CONTEXT}}` — MANDATORY

Ask: What problem is happening today, for whom, and why now? What exists already
that this changes or replaces? If the answer is "we just want feature X", ask what
breaks or what's missing *without* X — context is the problem, not the solution.
2-4 sentences max; if it needs a wall of text, the feature is probably still fuzzy.

---

## `{{GOALS}}` — MANDATORY

Ask: If this spec is fully built, what are the 2-5 things that will be true that
aren't true today? Each goal must be independently falsifiable — "improve
performance" is not a goal, "checkout completes in under 2s at p95" is. Reject
goals phrased as implementation steps ("add a cache") — that's a means, not a goal.

---

## `{{NON_GOALS}}` — MANDATORY

Ask: What adjacent, tempting thing are we deliberately NOT doing in this spec?
Prompt with the obvious candidates — "should this also handle X?", "is Y in scope
or a future spec?" — and write down every "no" explicitly. An empty Non-goals
section is a red flag, not a clean one: push back and ask again.

---

## `{{DEPENDENCIES_DETAIL}}` — OPTIONAL

Ask: Does this rely on another SPEC's interface, a new package, an infra resource,
an API key, or a third-party account? For each, name exactly what's needed — not
just "SPEC 02" but "SPEC 02's `UserRepository.findByEmail` signature". Omit this
entire section (heading and placeholder both) when the header's `Depends on:` is
empty and nothing external is required.

---

## `{{FUNCTIONAL_REQUIREMENTS}}` — MANDATORY

Ask: Walk me through what the system does, step by step, starting with the main
(happy) path. Convert each sentence into a discrete, numbered requirement an
implementer could check off independently. If a requirement needs "and" to
describe it, it's probably two requirements — split it.

---

## `{{INTERFACES_CONTRACTS}}` — MANDATORY

Ask: What does this expose or change that something else could call — an
endpoint, a function signature, an event payload, a DB column, a config key, a CLI
flag? For each, ask for the concrete shape (names, types, required/optional), not
just "an API for X". If truly nothing is exposed, write the explicit
`N/A — <reason>` line — never leave the heading with nothing under it.

---

## `{{NON_FUNCTIONAL_REQUIREMENTS}}` — OPTIONAL

Ask: Is there a specific number or hard constraint here — latency, throughput,
availability, a compliance/security rule, an accessibility requirement — beyond
what the rest of the repo already guarantees? If the honest answer is "nothing
beyond the usual", omit the entire section rather than writing generic boilerplate
like "should be fast and secure".

---

## `{{EDGE_CASES}}` — MANDATORY

Ask, explicitly, one at a time: What happens on empty input? On a duplicate
request? Under concurrent access? If a dependency is down or times out? If the
user lacks permission? If a value is at a boundary (zero, max, negative)? Record
the answer for every edge case that was actually asked — a thin list here usually
means the questions weren't asked, not that there are no edge cases.

---

## `{{ACCEPTANCE_CRITERIA}}` — MANDATORY

Ask: How will we know this is done — not "it works", but a checklist someone else
could verify without reading the code? Render every answer as a `- [ ]` item,
ideally Given/When/Then. Every Functional Requirement and every Edge Case above
should map to at least one criterion here — if one doesn't, go back and ask why.

---

## `{{RISKS}}` — OPTIONAL

Ask: What's the worst thing that could go wrong here — an irreversible migration,
a vendor limit, a breaking change for a consumer not listed in Dependencies, a
rollback that isn't actually possible? Omit this section only for a trivial,
fully-reversible change with no migration, no new external dependency, and no
security/perf surface — and say so explicitly when omitting it (e.g. "omitted: no
migration or external surface").

---

## `{{OPEN_QUESTIONS}}` — OPTIONAL

Ask: What, honestly, is still undecided? Don't let the author resolve it on the
spot just to avoid writing it down — that's exactly the kind of silent decision
this section exists to surface. List it here instead. Remind the author: a
non-empty Open Questions section blocks moving this spec from Draft/In review to
Approved — resolving every item (by answering it, or by explicitly deferring it to
a new spec) is a precondition for approval, not an afterthought.
