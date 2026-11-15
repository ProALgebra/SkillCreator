# Learning and curation prompts

The prompts adapt the task-class skill organization and lesson-distillation principles from Hermes Agent to this plugin's declarative proposal contracts. The reference is upstream commit `fd8a6c41ace59b476193c61002ce6a86d667b18a`:

- [Conversation learning: `_SKILL_REVIEW_PROMPT`](https://github.com/NousResearch/hermes-agent/blob/fd8a6c41ace59b476193c61002ce6a86d667b18a/agent/background_review.py#L532-L603).
- [Library consolidation: `CURATOR_REVIEW_PROMPT`](https://github.com/NousResearch/hermes-agent/blob/fd8a6c41ace59b476193c61002ce6a86d667b18a/agent/curator.py#L281-L459).

The text is adapted to the inputs, output schemas, and application behavior of each operation. Models return JSON; the server validates proposals and controls approval and publication.

## Verified learning

[`LEARNING_SYSTEM_PROMPT`](../src/learning.ts) extracts evidence-backed procedures from eligible verified session records. It asks for ordered steps, decision points, applicability limits, actionable pitfalls, and explicitly scoped standing preferences. Related lessons are combined within the delivered records, while speculative fixes and temporary claims that a tool is broken are excluded.

This operation receives no skill catalog. It cannot choose an existing skill by identifier, claim a library-wide duplicate check, or create supporting files. The server constructs `SKILL.md` from the candidate fields. Each evidence quotation must match delivered source content, and references must identify supporting records exactly.

## Conversation refinement

[`CONVERSATION_REVIEW_PROMPT`](../src/refine.ts) inspects an unverified immutable conversation snapshot and the supplied catalog context. It prefers an appropriate editable skill, skips already-covered lessons, and creates a task-class skill only when no supplied skill fits. Protected entries cannot be updated or bypassed through a duplicate. Truncation and omitted catalog entries limit what the model may conclude.

Existing-skill updates append a refinement section; they do not edit earlier instructions. The prompt therefore asks for focused amendments. A correction identifies the conflicting instruction and explicitly states the supported scope and replacement behavior. It must not claim the old text was removed. Changes requiring a full rewrite or resource-file edits are outside this operation. The optimizer can propose a complete root rewrite separately.

Evidence remains a quotation from the conversation, not a quotation from an existing skill or proof that a proposed action succeeded. A reference to a snapshot must use its immutable ID, not its session ID.

## Semantic optimization

[`OPTIMIZER_PROMPT`](../src/optimizer.ts) reviews a bounded batch of complete editable packages. It groups related workflows into task-class skills, distills repeated lessons, and preserves distinct conditions, commands, user preferences, safety gates, and failure handling. A shared prefix alone does not establish that two workflows should merge. Unsupported contradictions favor keeping the affected skills.

Every editable source appears in exactly one `keep`, `patch`, `merge`, or `archive` action. Patches return a complete root `SKILL.md` and retain the original name and resource paths. Merges return a shorter coherent root and link every supporting file through the supplied relocation maps. The server retains complete original packages byte for byte under `sources/<skill_id>/`; the model cannot reorganize or rewrite those resources.

Source quotations provide a review trail, not a semantic-equivalence guarantee. Inactivity alone is insufficient evidence of obsolescence. There are no minimum counts for updates, merges, archives, or instruction reduction; uncertain cases can remain unchanged. Candidate and action limits are ceilings, not targets.

## Verification

Existing integration tests exercise JSON acceptance, literal evidence, protected targets, duplicate results, proposal approval, complete-package preservation, and bounded model context. These checks establish compatibility with the server contracts; they do not measure the quality of model-generated skills. A comparison of learning quality requires evaluation on representative conversations and libraries using an actual model.
