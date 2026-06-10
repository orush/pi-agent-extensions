/**
 * Usage & Cost Extension
 *
 * Registers a `/usage` slash command (alias `/cost`) that reports, similarly
 * to the built-in `/session` command:
 *   - cumulative token usage for the current session branch
 *     (input / output / cache read / cache write / total)
 *   - cumulative cost in USD
 *   - current context-window usage (tokens + percent) via ctx.getContextUsage()
 *
 * Usage:
 *   1. This file lives in ~/.pi/agent/extensions/ so it is auto-discovered.
 *   2. Run /usage (or /cost) in any session.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	assistantMessages: number;
}

function collectTotals(ctx: ExtensionContext): Totals {
	const totals: Totals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
		assistantMessages: 0,
	};

	// Walk the active branch (the conversation path leading to the current leaf).
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;

		const usage = message.usage;
		if (!usage) continue;

		totals.assistantMessages++;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		totals.total += usage.totalTokens ?? 0;
		totals.cost += usage.cost?.total ?? 0;
	}

	return totals;
}

const fmtTokens = (n: number): string => n.toLocaleString("en-US");
const fmtCost = (n: number): string => `$${n.toFixed(4)}`;

function buildReport(ctx: ExtensionContext): string {
	const t = collectTotals(ctx);
	const context = ctx.getContextUsage();

	const lines: string[] = [];
	lines.push("Session usage & cost");
	lines.push("─────────────────────");
	lines.push(`Assistant turns : ${t.assistantMessages}`);
	lines.push(`Input tokens    : ${fmtTokens(t.input)}`);
	lines.push(`Output tokens   : ${fmtTokens(t.output)}`);
	lines.push(`Cache read      : ${fmtTokens(t.cacheRead)}`);
	lines.push(`Cache write     : ${fmtTokens(t.cacheWrite)}`);
	lines.push(`Total tokens    : ${fmtTokens(t.total)}`);
	lines.push(`Total cost      : ${fmtCost(t.cost)}`);

	if (context) {
		const tokens = context.tokens != null ? fmtTokens(context.tokens) : "unknown";
		const pct = context.percent != null ? `${context.percent.toFixed(1)}%` : "unknown";
		lines.push("─────────────────────");
		lines.push(`Context window  : ${fmtTokens(context.contextWindow)}`);
		lines.push(`Context used    : ${tokens} (${pct})`);
	}

	return lines.join("\n");
}

export default function usageCostExtension(pi: ExtensionAPI) {
	const handler = async (_args: string, ctx: ExtensionCommandContext) => {
		ctx.ui.notify(buildReport(ctx), "info");
	};

	pi.registerCommand("usage", {
		description: "Show session token usage and cost",
		handler,
	});

	pi.registerCommand("cost", {
		description: "Show session token usage and cost (alias of /usage)",
		handler,
	});

	// Tool so the LLM can report cost/usage when asked in a prompt
	// (e.g. "what's the cost so far?" or "show token usage").
	pi.registerTool({
		name: "session_cost",
		label: "Session Cost",
		description:
			"Report the current session's cumulative token usage and cost in USD, " +
			"plus current context-window usage. Call this when the user asks about " +
			"cost, spend, token usage, or context size.",
		promptSnippet: "Report session token usage and cost when the user asks",
		promptGuidelines: [
			"Use session_cost when the user asks about cost, spend, token usage, or context size.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const report = buildReport(ctx);
			return {
				content: [{ type: "text", text: report }],
				details: collectTotals(ctx),
			};
		},
	});
}
