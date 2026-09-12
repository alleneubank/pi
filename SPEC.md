# SPEC: Mid-prompt skill autocomplete

## Problem

Slash-command autocomplete only fired when `/` was the first character of the
prompt. Typing a skill token in the middle of a prompt ("use /skil to commit")
offered nothing.

## Solution

`/` becomes a trigger character at token boundaries (like `@` and `#`). A
slash-led token on any line fuzzy-completes **skill commands only** —
the one command family that has an in-context reference mechanism. Completing
a token inserts `/skill:name` as a literal reference; the model resolves it
from the `<available_skills>` block in the system prompt (name, description,
location) and reads the SKILL.md on demand. Action commands (`/model`,
`/settings`, ...) stay at the start of the first line. Nothing expands mid-prompt.

## Domain model

- `CombinedAutocompleteProvider` (`packages/tui/src/autocomplete.ts`) —
  declares `triggerCharacters = ["/"]`; `getSuggestions` branches: `@`
  attachments → line-start slash commands (line 0) → mid-prompt slash tokens
  (any line, `!force`, filtered to `skill:`-namespaced commands) → file paths.
  `applyCompletion` replaces a slash token in place: command items get a
  leading `/`, path/argument items already carry it (no double slash).
- `Editor` (`packages/tui/src/components/editor.ts`) — the generic trigger-char
  machinery drives slash triggering; `selectConfirm` (Enter) accepts the
  highlighted completion (first-line command completions additionally submit).

## Requirements

- `REQ-TUI-001` A slash-led token at a word boundary on any line ("use /skil",
  or "/skil" at the start of a later line) fuzzy-completes skill commands;
  the prefix is the full token.
- `REQ-TUI-002` Mid-prompt suggestions are limited to `skill:`-namespaced
  commands; action commands never appear mid-prompt.
- `REQ-TUI-003` The start of the first line keeps the full command palette,
  trailing space, and submit-on-Enter behavior.
- `REQ-TUI-004` A slash not at a word boundary ("use/skil") never hijacks
  prose; a bare `/` at a boundary opens the skill palette.
- `REQ-TUI-005` Non-matching slash tokens fall through to path completion;
  an empty path prefix after a space yields nothing (backspacing past `/`
  closes the list).
- `REQ-TUI-006` Enter accepts the highlighted completion in place (no trailing
  space, no submit) mid-prompt, including later-line starts; Tab also accepts.
  First-line command completions additionally submit on Enter.
- `REQ-TUI-007` Lines 1+ offer only skill references, including after collapsed
  paste markers, blank lines, and separators. Accepting a reference preserves
  surrounding text, paste content, cursor placement, and undo.
- `REQ-CA-008` Mid-prompt `/skill:name` tokens stay literal references; only
  message-start `/skill:name [args]` expands to the full block. No template
  expansion, no block rendering, no coding-agent changes.

## Invariants

- `INV-1` First-line command behavior is unchanged (command names,
  argument completions, trailing space, Enter).
- `INV-2` `@` file-attachment autocomplete is unchanged.
- `INV-3` The coding-agent package is untouched by this feature.

## Non-goals

- No mid-prompt execution of action commands or extension commands.
- No mid-prompt expansion of any kind (skills stay references; templates stay
  message-start).
- No multi-block skill rendering (a pasted skill block mid-prose renders as
  raw text, unchanged from upstream).
- No changes to skill loading, the system prompt, or the wire protocol.

## Decisions

- `D1` Mid-prompt palette = `skill:`-namespaced commands only. Rationale:
  skills are the one command family with an in-context reference mechanism;
  the prefix already namespaces them, so no new capability flag is needed.
- `D2` Mid-prompt completion inserts a reference, not an expansion. Rationale:
  the system prompt already carries name/description/location for every skill;
  the full block dump is redundant token spend and destroys sentence
  readability.
- `D3` Enter accepts the highlighted completion (standard completion UX); Tab
  also accepts. First-line command completions additionally submit.
- `D4` (ratified) Later-line starts are embedded-reference positions, not command
  invocations. Skills remain completable below pasted context without risking
  accidental submission when Enter accepts a suggestion.

## Acceptance criteria

- [x] `REQ-TUI-001..007` covered in `packages/tui/test/autocomplete.test.ts` and `packages/tui/test/editor.test.ts`
- [x] Full `packages/tui` suite and `npm run check` pass
- [x] Live-verified in a terminal (tmux): later-line skill palette below a collapsed paste, Enter accepts in place, backspace closes

## Test traceability

| REQ | Test |
| --- | --- |
| `REQ-TUI-001` | `autocomplete.test.ts` "suggests commands for a slash token in the middle of a prompt"; `editor.test.ts` "opens the command list when typing a slash token mid-prompt" |
| `REQ-TUI-002` | `autocomplete.test.ts` "offers only skill commands for a bare slash", "excludes action commands from the mid-prompt palette"; `editor.test.ts` "does not open for action commands mid-prompt" |
| `REQ-TUI-003` | `autocomplete.test.ts` "keeps the full command list at line start", "keeps line-start completion trailing space" |
| `REQ-TUI-004` | `autocomplete.test.ts` "does not suggest commands when the slash is not at a word boundary"; `editor.test.ts` "does not open when the slash is not at a word boundary" |
| `REQ-TUI-005` | `autocomplete.test.ts` "returns nothing for a trailing space with no slash token"; `editor.test.ts` "closes the list when backspacing past the slash token" |
| `REQ-TUI-006` | `editor.test.ts` "applies a mid-prompt completion on Enter in place without submitting", "accepts a mid-prompt completion on Tab without submitting" |
| `REQ-TUI-007` | `autocomplete.test.ts` "offers only skills on later lines", "inserts a later-line skill reference in place"; `editor.test.ts` "accepts a later-line skill", "completes recall below a collapsed paste and separator without submitting", "cancels and reopens later-line skills" |
| `REQ-CA-008` | no code: mid-prompt expansion does not exist (upstream `_expandSkillCommand` is message-start only) |
