/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 * Per-question multiSelect: toggle choices, then confirm the answer
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
	multiSelect: boolean;
}

interface SingleAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface MultiAnswer {
	id: string;
	values: string[];
	labels: string[];
	custom?: string;
}

type Answer = SingleAnswer | MultiAnswer;

interface MultiDraft {
	selected: Set<number>;
	custom?: string;
}

function answerSummary(answer: Answer): string {
	if ("values" in answer) {
		return [...answer.labels, ...(answer.custom ? [`(wrote) ${answer.custom}`] : [])].join(", ");
	}
	return `${answer.wasCustom ? "(wrote) " : ""}${answer.label}`;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Allow multiple selections for this question (default: false)" }),
	),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. Set multiSelect: true on any question to allow multiple choices and an optional custom answer. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		parameters: QuestionnaireParams,
		executionMode: "sequential",

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}
			if (signal?.aborted) return errorResult("User cancelled the questionnaire");

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
				multiSelect: q.multiSelect === true,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const request = {
				requestId: toolCallId,
				sessionId: ctx.sessionManager.getSessionId(),
				toolName: "questionnaire",
				summary: "Questionnaire needs your input",
			};
			let inputRequested = false;
			let removeAbortListener = () => {};
			let result: QuestionnaireResult;
			try {
				result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, kb, done) => {
					// State
					let currentTab = 0;
					let optionIndex = 0;
					let inputMode = false;
					let inputQuestionId: string | null = null;
					let cachedLines: string[] | undefined;
					const answers = new Map<string, Answer>();
					const drafts = new Map<string, MultiDraft>(
						questions.filter((q) => q.multiSelect).map((q) => [q.id, { selected: new Set<number>() }]),
					);

					// Editor for "Type something" option
					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					// Helpers
					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function submit(cancelled: boolean) {
						done({ questions, answers: Array.from(answers.values()), cancelled });
					}

					function currentQuestion(): Question | undefined {
						return questions[currentTab];
					}

					function currentOptions(): RenderOption[] {
						const q = currentQuestion();
						if (!q) return [];
						const opts: RenderOption[] = [...q.options];
						if (q.allowOther) {
							opts.push({ value: "__other__", label: "Type something.", isOther: true });
						}
						return opts;
					}

					function advanceAfterAnswer() {
						if (!isMulti) {
							submit(false);
							return;
						}
						if (currentTab < questions.length - 1) {
							currentTab++;
						} else {
							currentTab = questions.length; // Submit tab
						}
						optionIndex = 0;
						refresh();
					}

					function saveAnswer(
						questionId: string,
						value: string,
						label: string,
						wasCustom: boolean,
						index?: number,
					) {
						answers.set(questionId, { id: questionId, value, label, wasCustom, index });
					}

					function editCustomAnswer(q: Question) {
						inputMode = true;
						inputQuestionId = q.id;
						editor.setText(drafts.get(q.id)?.custom ?? "");
						refresh();
					}

					editor.onSubmit = (value) => {
						if (!inputQuestionId) return;
						const draft = drafts.get(inputQuestionId);
						if (draft) {
							draft.custom = value.trim() || undefined;
							answers.delete(inputQuestionId);
						} else {
							const trimmed = value.trim() || "(no response)";
							saveAnswer(inputQuestionId, trimmed, trimmed, true);
						}
						inputMode = false;
						inputQuestionId = null;
						editor.setText("");
						if (draft) {
							optionIndex = 0;
							refresh();
						} else {
							advanceAfterAnswer();
						}
					};

					function handleInput(data: string) {
						if (inputMode) {
							if (kb.matches(data, "tui.select.cancel")) {
								inputMode = false;
								inputQuestionId = null;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						if (kb.matches(data, "tui.select.cancel")) {
							submit(true);
							return;
						}

						if (isMulti) {
							if (kb.matches(data, "app.questionnaire.next")) {
								currentTab = (currentTab + 1) % totalTabs;
								optionIndex = 0;
								refresh();
								return;
							}
							if (kb.matches(data, "app.questionnaire.previous")) {
								currentTab = (currentTab - 1 + totalTabs) % totalTabs;
								optionIndex = 0;
								refresh();
								return;
							}
						}

						if (currentTab === questions.length) {
							if (kb.matches(data, "tui.select.confirm")) submit(false);
							return;
						}

						const q = currentQuestion();
						if (!q) return;
						const opts = currentOptions();
						const draft = drafts.get(q.id);

						if (kb.matches(data, "tui.select.up")) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (kb.matches(data, "tui.select.down")) {
							optionIndex = Math.max(0, Math.min(opts.length - 1, optionIndex + 1));
							refresh();
							return;
						}

						const opt = opts[optionIndex];
						if (draft && opt && kb.matches(data, "app.questionnaire.toggle")) {
							if (opt.isOther) {
								if (draft.custom) draft.custom = undefined;
								else editCustomAnswer(q);
							} else if (draft.selected.has(optionIndex)) {
								draft.selected.delete(optionIndex);
							} else {
								draft.selected.add(optionIndex);
							}
							answers.delete(q.id);
							refresh();
							return;
						}

						if (kb.matches(data, "tui.select.confirm")) {
							if (opt?.isOther && (!draft || !draft.custom)) {
								editCustomAnswer(q);
								return;
							}
							if (draft) {
								if (draft.selected.size === 0 && !draft.custom) return;
								const selected = q.options.filter((_, index) => draft.selected.has(index));
								answers.set(q.id, {
									id: q.id,
									values: selected.map((o) => o.value),
									labels: selected.map((o) => o.label),
									custom: draft.custom,
								});
							} else if (opt) {
								saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
							} else {
								return;
							}
							advanceAfterAnswer();
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const renderWidth = Math.max(1, width);
						const q = currentQuestion();
						const opts = currentOptions();
						const draft = q ? drafts.get(q.id) : undefined;
						const confirmKey = kb.getKeys("tui.select.confirm").join("/") || "unbound";
						const cancelKey = kb.getKeys("tui.select.cancel").join("/") || "unbound";

						function addWrapped(text: string) {
							lines.push(...wrapTextWithAnsi(text, renderWidth));
						}

						function addWrappedWithPrefix(prefix: string, text: string) {
							const prefixWidth = visibleWidth(prefix);
							if (prefixWidth >= renderWidth) {
								addWrapped(prefix + text);
								return;
							}
							const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
							const continuationPrefix = " ".repeat(prefixWidth);
							for (let i = 0; i < wrapped.length; i++) {
								lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
							}
						}

						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						// Tab bar (multi-question only)
						if (isMulti) {
							const tabs: string[] = ["← "];
							for (let i = 0; i < questions.length; i++) {
								const isActive = i === currentTab;
								const isAnswered = answers.has(questions[i].id);
								const lbl = questions[i].label;
								const box = isAnswered ? "■" : "□";
								const color = isAnswered ? "success" : "muted";
								const text = ` ${box} ${lbl} `;
								const styled = isActive
									? theme.bg("selectedBg", theme.fg("text", text))
									: theme.fg(color, text);
								tabs.push(`${styled} `);
							}
							const isSubmitTab = currentTab === questions.length;
							const submitText = " ✓ Submit ";
							const submitStyled = isSubmitTab
								? theme.bg("selectedBg", theme.fg("text", submitText))
								: theme.fg("success", submitText);
							tabs.push(`${submitStyled} →`);
							addWrappedWithPrefix(" ", tabs.join(""));
							lines.push("");
						}

						// Helper to render options list
						function renderOptions() {
							for (let i = 0; i < opts.length; i++) {
								const opt = opts[i];
								const selected = i === optionIndex;
								const isOther = opt.isOther === true;
								const prefix = selected ? theme.fg("accent", "> ") : "  ";
								const checked = isOther ? Boolean(draft?.custom) : draft?.selected.has(i);
								const checkbox = draft ? (checked ? "[x] " : "[ ] ") : "";
								const optionLabel = isOther && draft?.custom ? `Other: ${draft.custom}` : opt.label;
								const label = `${checkbox}${i + 1}. ${optionLabel}${isOther && inputMode ? " ✎" : ""}`;
								const color = selected || (isOther && inputMode) ? "accent" : "text";

								addWrappedWithPrefix(prefix, theme.fg(color, label));
								if (opt.description) {
									addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
								}
							}
						}

						// Content
						if (inputMode && q) {
							addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
							lines.push("");
							// Show options for reference
							renderOptions();
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) {
								lines.push(` ${line}`);
							}
							lines.push("");
							const submitKey = kb.getKeys("tui.input.submit").join("/") || "unbound";
							addWrappedWithPrefix(" ", theme.fg("dim", `${submitKey} to submit • ${cancelKey} to go back`));
						} else if (currentTab === questions.length) {
							addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
							lines.push("");
							for (const question of questions) {
								const answer = answers.get(question.id);
								if (answer) {
									const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", answerSummary(answer))}`;
									addWrappedWithPrefix(" ", summary);
								}
							}
							lines.push("");
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							if (missing) {
								addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
							}
							addWrappedWithPrefix(" ", theme.fg("success", `Press ${confirmKey} to submit`));
						} else if (q) {
							addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
							lines.push("");
							renderOptions();
						}

						lines.push("");
						if (!inputMode) {
							const hints: string[] = [];
							if (isMulti) {
								const nextKey = kb.getKeys("app.questionnaire.next").join("/") || "unbound";
								const previousKey = kb.getKeys("app.questionnaire.previous").join("/") || "unbound";
								hints.push(`${nextKey} next tab`, `${previousKey} previous tab`);
							}
							if (q) {
								const upKey = kb.getKeys("tui.select.up").join("/") || "unbound";
								const downKey = kb.getKeys("tui.select.down").join("/") || "unbound";
								hints.push(`${upKey}/${downKey} navigate`);
							}
							if (draft) {
								const toggleKey = kb.getKeys("app.questionnaire.toggle").join("/") || "unbound";
								hints.push(`${toggleKey} toggle`);
								if (draft.selected.size === 0 && !draft.custom) {
									addWrappedWithPrefix(
										" ",
										theme.fg("muted", "Select at least one option or type an answer."),
									);
								}
							}
							hints.push(`${confirmKey} confirm`, `${cancelKey} cancel`);
							addWrappedWithPrefix(" ", theme.fg("dim", hints.join(" • ")));
						}
						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						cachedLines = lines;
						return lines;
					}

					const onAbort = () => submit(true);
					signal?.addEventListener("abort", onAbort, { once: true });
					removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) {
						onAbort();
					} else {
						inputRequested = true;
						pi.events.emit("pi:user-input", { ...request, type: "opened" });
					}
					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				});
			} finally {
				removeAbortListener();
				if (inputRequested) pi.events.emit("pi:user-input", { ...request, type: "closed" });
			}

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if ("values" in a) {
					return `${qLabel}: ${JSON.stringify({ values: a.values, labels: a.labels, custom: a.custom })}`;
				}
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			for (const question of questions) {
				if (!result.answers.some((answer) => answer.id === question.id)) {
					answerLines.push(`${question.label}: unanswered`);
				}
			}

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if ("values" in a) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${answerSummary(a)}`;
				}
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			for (const question of details.questions) {
				if (!details.answers.some((answer) => answer.id === question.id)) {
					lines.push(theme.fg("warning", `${question.label}: unanswered`));
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
