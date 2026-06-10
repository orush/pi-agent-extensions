/**
 * Failure clusterization for Allure 3 reports.
 *
 * Single responsibility: read `data/test-results/*.json`, take the failing /
 * broken tests, and group them by a normalized **Java** error signature so that
 * "the same root cause seen in N tests" collapses into one cluster.
 *
 * The signature is built from the whole exception chain (the thrown exception
 * plus every `Caused by:`) and the top application stack frame. Dynamic noise
 * (UUIDs, session ids, hex ids, URLs, timestamps, numbers, quoted literals) is
 * stripped so structurally identical errors share a key.
 *
 * The output is intentionally lean — no execution stats, skip/flaky/slowest/tag
 * analytics — to avoid bloating the context of an LLM consuming it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TestStatus = "passed" | "failed" | "broken" | "skipped" | "unknown";

export interface AllureError {
	message?: string;
	trace?: string;
}

interface RawTestResult {
	id: string;
	name: string;
	status: TestStatus;
	error?: AllureError;
	labels?: Array<{ name: string; value: string }>;
	categories?: Array<{ name?: string }>;
	/** Same value across every attempt (retry) of one test. */
	historyId?: string;
	/** Allure marks superseded prior retry attempts as hidden. */
	hidden?: boolean;
	/** True on the surviving result when the test was retried. */
	retry?: boolean;
	/** Number of prior attempts on the surviving result (0 on prior attempts). */
	retriesCount?: number;
	/** Prior retry attempts, present on the surviving result. */
	retries?: Array<{ id: string }>;
}

/** A single failure cluster — the model-facing unit. */
export interface FailureCluster {
	/** One-line title: `SimpleType: message` (with ` ⇐ rootCause` when chained). */
	title: string;
	/** Number of failing/broken tests in this cluster. */
	count: number;
	/** Fully-qualified type of the thrown (outermost) exception. */
	exceptionType?: string;
	/** Deepest `Caused by` exception (`SimpleType: message`), if any. */
	rootCause?: string;
	/** Top application stack frame `pkg.Class.method(File.java:line)`. */
	location?: string;
	/** Allure category names attached to tests in this cluster. */
	categories: string[];
	/** Number of distinct suites impacted (not the full list, to stay lean). */
	suiteCount: number;
	/** A few example test names. */
	examples: string[];
	/** How many affected tests are not listed in `examples`. */
	examplesTruncated: number;
	/** Representative trace excerpt: full exception/cause messages + app frames. */
	sample: string;
}

export interface ClusterReport {
	/** Number of failing/broken tests considered (surviving attempts only). */
	failuresAnalyzed: number;
	/**
	 * Failed/broken prior attempts excluded because the test ultimately passed on
	 * retry ("successfully retried" / flaky). Omitted when zero (or when retries
	 * are included via `includeRetriedAttempts`).
	 */
	retriedExcluded?: number;
	/** Total distinct clusters found (before any selection). */
	totalClusters: number;
	/** Share of all failures (%) covered by the shown `clusters`. */
	coveredPct: number;
	/** Application package prefixes used to keep app frames in `sample`. */
	appPackages: string[];
	/** Shown clusters, highest-impact first (progressive selection). */
	clusters: FailureCluster[];
	/** Collapsed long tail of clusters that were not shown (omitted when none). */
	tail?: { clusters: number; failures: number; pct: number };
}

export interface ClusterOptions {
	/** Allure report dir (or its `data`/`test-results` dir). Defaults to cwd. */
	reportDir?: string;
	/**
	 * Progressive output: drop clusters that individually account for less than this
	 * percentage of all failing tests (0–100). Such small clusters are usually
	 * derivatives of the dominant ones; they are collapsed into `tail`. Default 5.
	 */
	minClusterPct?: number;
	/**
	 * When `failuresAnalyzed` is at or below this, show ALL clusters regardless of
	 * `minClusterPct` (few failures → full detail). Default 20.
	 */
	allClustersBelow?: number;
	/** Hard ceiling on shown clusters, applied after the minClusterPct selection. Default 20. */
	maxClusters?: number;
	/** Max example test names per cluster. Default 3. */
	maxExamples?: number;
	/** Max application stack frames per exception in each cluster `sample`. Default 8. */
	maxFrames?: number;
	/**
	 * Include superseded retry attempts in the analysis. By default (`false`) only the
	 * surviving attempt of each test is clustered, so tests that failed but ultimately
	 * passed on retry ("successfully retried" / flaky) are excluded and retried-then-failed
	 * tests are counted once. Set to `true` to count every recorded attempt (legacy).
	 */
	includeRetriedAttempts?: boolean;
	/**
	 * Package prefixes (e.g. `["org.example"]`) whose stack frames are kept in
	 * `sample`. When omitted, falls back to the `ALLURE_APP_PACKAGES` env var
	 * (comma-separated); if that is also empty, any non-library frame is kept.
	 */
	appPackages?: string[];
}

// ---------------------------------------------------------------------------
// Report directory discovery
// ---------------------------------------------------------------------------

function looksLikeResultsDir(dir: string): boolean {
	if (!existsSync(dir)) return false;
	try {
		if (!statSync(dir).isDirectory()) return false;
		return readdirSync(dir).some((f) => f.endsWith(".json"));
	} catch {
		return false;
	}
}

/**
 * Resolve a report directory to the concrete `test-results` directory.
 * Accepts: the report root, the `data` dir, or the `test-results` dir itself.
 */
export function resolveResultsDir(input: string): { reportDir: string; resultsDir: string } {
	const candidates: Array<{ reportDir: string; resultsDir: string }> = [
		{ reportDir: input, resultsDir: join(input, "data", "test-results") },
		{ reportDir: input, resultsDir: join(input, "test-results") },
		{ reportDir: dirname(input), resultsDir: input }, // input IS test-results
		{ reportDir: dirname(dirname(input)), resultsDir: input },
	];
	for (const c of candidates) {
		if (looksLikeResultsDir(c.resultsDir)) return c;
	}
	throw new Error(
		`Could not find Allure test results under "${input}". ` +
			`Expected a "data/test-results" directory with *.json files.`,
	);
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RE = /\b[0-9a-f]{12,}\b/gi;
const URL_RE = /https?:\/\/[^\s"'>)\]]+/gi;
const TS_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
// Decimals/amounts (e.g. 0.20000) are always dynamic.
const DECIMAL_RE = /\b\d+\.\d+\b/g;
// Numbers attached to an id-like key (brandId=34, playerId=1233336254) are dynamic
// regardless of length — normalize the value but keep the key.
const KEYED_ID_RE = /\b(\w*?[Ii]d)=\d+/g;
// Remaining long integer runs (>= INT_NORMALIZE_MIN_DIGITS) are ids/ports/epochs.
// Short integers (1–3 digits) are KEPT so HTTP status codes (200/401/500) and small
// counts stay discriminating.
const INT_NORMALIZE_MIN_DIGITS = 4;
const LONG_INT_RE = new RegExp(`\\b\\d{${INT_NORMALIZE_MIN_DIGITS},}\\b`, "g");

/** First non-empty line of a message, trimmed and length-capped. */
function firstLine(msg: string | undefined, maxLen = 200): string {
	if (!msg) return "";
	const line = msg.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
	return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

/**
 * Strip dynamic content so that structurally identical errors share a signature.
 *
 * Numbers are normalized by meaning, not blindly: amounts/ids/long integers become
 * placeholders, but short integers (1–3 digits) are preserved so discriminating
 * values like HTTP status codes (200 vs 401 vs 500) keep distinct clusters apart.
 */
export function normalizeForSignature(text: string): string {
	return text
		.replace(UUID_RE, "<uuid>")
		.replace(URL_RE, "<url>")
		.replace(TS_RE, "<ts>")
		.replace(HEX_RE, "<hex>")
		.replace(/"[^"]*"/g, '"<v>"')
		.replace(/'[^']*'/g, "'<v>'")
		.replace(DECIMAL_RE, "<num>")
		.replace(KEYED_ID_RE, "$1=<id>")
		.replace(LONG_INT_RE, "<id>")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

// ---------------------------------------------------------------------------
// Java stack-trace parsing
// ---------------------------------------------------------------------------
//
// Stack traces are assumed to be Java. We parse the whole exception chain
// (the thrown exception plus every `Caused by:`/`Suppressed:` entry) and locate
// the top *application* frame, skipping JDK/library frames.

/** Package prefixes that are never the "interesting" throw site. */
const LIBRARY_PREFIXES = [
	"java.", "javax.", "jakarta.", "jdk.", "sun.", "com.sun.",
	"kotlin.", "scala.", "groovy.", "org.codehaus.groovy.",
	"org.junit", "junit.", "org.opentest4j", "org.testng",
	"org.assertj", "org.hamcrest", "org.mockito", "net.bytebuddy",
	"org.springframework", "org.apache", "com.fasterxml", "com.google",
	"org.gradle", "worker.org.gradle", "io.cucumber", "org.spockframework",
	"reactor.", "io.netty", "okhttp3.", "okio.", "retrofit2.", "feign.",
	"org.slf4j", "ch.qos", "io.qameta", "io.rest-assured", "io.restassured",
	"org.awaitility",
];

interface JavaFrame {
	fq: string;
	loc: string;
}

interface JavaException {
	type: string;
	simpleType: string;
	message: string;
	frames: JavaFrame[];
}

interface ParsedTrace {
	exceptions: JavaException[];
	appFrame?: string;
}

const FRAME_RE = /^\s*at\s+([\w$.]+)\(([^)]*)\)\s*$/;
const CAUSED_RE = /^\s*Caused by:\s*(.*)$/;
const SUPPRESSED_RE = /^\s*Suppressed:\s*(.*)$/;
const ELISION_RE = /^\s*\.\.\.\s*(?:\d+\s*more|\[?\d+ frames? hidden)/i;

/** Per-exception message budget when building a signature (full message, capped). */
const SIG_MSG_CAP = 600;
/** Max message chars preserved per exception in `sample`. */
const SAMPLE_MSG_CAP = 2000;
/** Default application frames kept per exception block in `sample`. */
const DEFAULT_MAX_FRAMES = 8;
/** Always show at least this many clusters (so output is never empty when failures exist). */
const MIN_SHOWN_CLUSTERS = 1;

/** A prefix matches a frame only on a package boundary (avoids `org.ex` vs `org.example`). */
function packageMatches(fq: string, prefix: string): boolean {
	const p = prefix.endsWith(".") ? prefix.slice(0, -1) : prefix;
	return fq === p || fq.startsWith(`${p}.`);
}

/** Class portion of a fully-qualified `pkg.Class.method` frame reference. */
function classOfFrame(fqMethod: string): string {
	const idx = fqMethod.lastIndexOf(".");
	return idx > 0 ? fqMethod.slice(0, idx) : fqMethod;
}

function isLibraryFrame(fqMethod: string): boolean {
	return LIBRARY_PREFIXES.some((p) => classOfFrame(fqMethod).startsWith(p));
}

/** Keep a frame in `sample`? Configured app packages win; else any non-library frame. */
function frameMatchesApp(fq: string, appPackages: string[]): boolean {
	if (appPackages.length) return appPackages.some((p) => packageMatches(fq, p));
	return !isLibraryFrame(fq);
}

/** Resolve app packages: explicit option → ALLURE_APP_PACKAGES env → [] (non-library fallback). */
export function resolveAppPackages(opts: { appPackages?: string[] } = {}): string[] {
	if (opts.appPackages && opts.appPackages.length) {
		return opts.appPackages.map((s) => s.trim()).filter(Boolean);
	}
	const env = process.env.ALLURE_APP_PACKAGES;
	if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
	return [];
}

function simpleClassName(fqcn: string): string {
	return fqcn.slice(fqcn.lastIndexOf(".") + 1) || fqcn;
}

/** Parse an exception header block (`com.foo.Bar: message` + continuation lines). */
function parseExceptionHeader(headerLines: string[]): JavaException {
	const first = (headerLines[0] ?? "").trim();
	const rest = headerLines.slice(1).map((l) => l.trim()).filter(Boolean);
	const m = first.match(/^([\w$.]+)(?::\s?([\s\S]*))?$/);
	let type = "";
	let message = first;
	if (m && /(?:exception|error|throwable)/i.test(m[1])) {
		type = m[1];
		message = m[2] ?? "";
	} else if (m && m[1].includes(".") && m[2] !== undefined) {
		type = m[1];
		message = m[2] ?? "";
	}
	const full = [message, ...rest].join("\n").trim();
	return { type, simpleType: type ? simpleClassName(type) : "", message: full, frames: [] };
}

/** Parse a Java stack trace (falling back to a bare message) into its chain + location. */
export function parseJavaTrace(trace?: string, fallbackMessage?: string): ParsedTrace {
	const text = trace?.trim();
	if (!text) {
		const exceptions = fallbackMessage
			? [parseExceptionHeader(fallbackMessage.split(/\r?\n/))]
			: [];
		return { exceptions };
	}

	type Block = { headerLines: string[]; frames: JavaFrame[] };
	const blocks: Block[] = [];
	let cur: Block | null = null;

	for (const raw of text.split(/\r?\n/)) {
		const caused = raw.match(CAUSED_RE) ?? raw.match(SUPPRESSED_RE);
		const frame = raw.match(FRAME_RE);
		if (caused) {
			cur = { headerLines: [caused[1]], frames: [] };
			blocks.push(cur);
		} else if (frame) {
			if (!cur) {
				cur = { headerLines: [], frames: [] };
				blocks.push(cur);
			}
			cur.frames.push({ fq: frame[1], loc: frame[2] });
		} else if (ELISION_RE.test(raw)) {
			// "... N more" / "[N frames hidden]" — ignore
		} else {
			const trimmed = raw.trim();
			if (!trimmed) continue;
			if (!cur) {
				cur = { headerLines: [trimmed], frames: [] };
				blocks.push(cur);
			} else if (cur.frames.length === 0) {
				cur.headerLines.push(trimmed); // multi-line message before frames
			}
			// else: trailing prose after frames — ignore
		}
	}

	const exceptions = blocks.map((b) => {
		const e = parseExceptionHeader(b.headerLines);
		e.frames = b.frames;
		return e;
	});
	let appFrame: string | undefined;
	const primaryFrames = blocks[0]?.frames ?? [];
	if (primaryFrames.length) {
		const app = primaryFrames.find((f) => !isLibraryFrame(f.fq)) ?? primaryFrames[0];
		appFrame = `${app.fq}(${app.loc})`;
	}
	return { exceptions, appFrame };
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

export interface FailureSignature {
	key: string;
	title: string;
	location?: string;
	exceptionType?: string;
	rootCause?: string;
	sample: string;
}

/** Non-empty lines of an exception message, trimmed, with an overall char cap. */
function messageLines(message: string, maxChars = SAMPLE_MSG_CAP): string[] {
	const capped =
		message.length > maxChars ? `${message.slice(0, maxChars)} …(message truncated)` : message;
	return capped.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Build a compact, LLM-friendly trace excerpt: for every exception in the chain
 * keep its header + the **full** message (all lines, up to {@link SAMPLE_MSG_CAP}
 * chars), then up to `maxFrames` application stack frames. Library frames drop.
 */
function buildSample(chain: JavaException[], appPackages: string[], maxFrames: number): string {
	const out: string[] = [];
	chain.forEach((e, i) => {
		const head = `${i === 0 ? "" : "Caused by: "}${e.type ? `${e.type}: ` : ""}`;
		const lines = messageLines(e.message);
		out.push(`${head}${lines[0] ?? ""}`.trimEnd());
		for (const extra of lines.slice(1)) out.push(`  ${extra}`);
		const appFrames = e.frames.filter((f) => frameMatchesApp(f.fq, appPackages));
		for (const f of appFrames.slice(0, maxFrames)) out.push(`    at ${f.fq}(${f.loc})`);
		if (appFrames.length > maxFrames) {
			out.push(`    … ${appFrames.length - maxFrames} more application frames`);
		}
	});
	return out.join("\n").trim() || "(no message)";
}

/**
 * Build a clustering signature from a Java error using the **entire** exception
 * chain (every `Caused by:`) plus the top application frame.
 */
export function buildFailureSignature(
	error: AllureError | undefined,
	options: { appPackages?: string[]; maxFrames?: number } = {},
): FailureSignature {
	const appPackages = options.appPackages ?? [];
	const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
	const parsed = parseJavaTrace(error?.trace, error?.message);
	const chain: JavaException[] = parsed.exceptions.length
		? parsed.exceptions
		: [{ type: "", simpleType: "", message: error?.message ?? "", frames: [] }];

	// Signature: normalized type + FULL message for every exception in the chain
	// (capped), anchored on the application throw site.
	const sigParts = chain.map((e) => {
		const msg = normalizeForSignature(e.message).slice(0, SIG_MSG_CAP);
		return e.type ? `${e.type}: ${msg}` : msg;
	});
	const key = `${sigParts.join(" |caused-by| ")} @@ ${parsed.appFrame ?? ""}`;

	const headOf = (e: JavaException) => {
		const label = e.simpleType || "error";
		const line = firstLine(e.message, 160);
		return line ? `${label}: ${line}` : label;
	};
	const root = chain[chain.length - 1];
	const rootCause =
		chain.length > 1 ? `${root.simpleType || "cause"}: ${firstLine(root.message, 200)}` : undefined;
	const title = rootCause ? `${headOf(chain[0])}  ⇐  ${rootCause}` : headOf(chain[0]) || "(no message)";

	return {
		key,
		title,
		location: parsed.appFrame,
		exceptionType: chain[0].type || undefined,
		rootCause,
		sample: buildSample(chain, appPackages, maxFrames),
	};
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

function suiteOf(labels: RawTestResult["labels"]): string | undefined {
	const suite = (labels ?? []).find((l) => l.name === "suite");
	if (suite) return suite.value;
	return (labels ?? []).find((l) => l.name === "testClass")?.value;
}

/** Read an Allure report and cluster its failing/broken tests by error signature. */
export function clusterFailures(opts: ClusterOptions = {}): ClusterReport {
	const reportRoot = opts.reportDir ?? process.cwd();
	const maxClusters = opts.maxClusters ?? 20;
	const maxExamples = opts.maxExamples ?? 3;
	const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
	const minClusterPct = Math.min(100, Math.max(0, opts.minClusterPct ?? 5));
	const allClustersBelow = opts.allClustersBelow ?? 20;
	const appPackages = resolveAppPackages(opts);

	const includeRetriedAttempts = opts.includeRetriedAttempts ?? false;

	const { resultsDir } = resolveResultsDir(reportRoot);
	const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json"));

	// Pass 1: parse everything once. Allure stores each retry attempt as its own
	// result file; the surviving attempt references the superseded ones via `retries[]`
	// and the latter are flagged `hidden`. We build the set of superseded attempt ids
	// and a historyId→surviving-result index so we can (a) cluster only the surviving
	// attempt of each test and (b) tell whether an excluded failed attempt was
	// ultimately retried green.
	const parsed: RawTestResult[] = [];
	const priorAttemptIds = new Set<string>();
	const survivorByHistoryId = new Map<string, RawTestResult>();
	for (const file of files) {
		let t: RawTestResult;
		try {
			t = JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as RawTestResult;
		} catch {
			continue;
		}
		if (!t || !t.id) continue;
		parsed.push(t);
		for (const r of t.retries ?? []) if (r?.id) priorAttemptIds.add(r.id);
		if (!t.hidden && t.historyId) survivorByHistoryId.set(t.historyId, t);
	}

	/** A superseded prior retry attempt (not the surviving result of its test). */
	const isPriorAttempt = (t: RawTestResult): boolean =>
		priorAttemptIds.has(t.id) || t.hidden === true;

	/** Did the test this failed attempt belongs to ultimately pass? */
	const wasRetriedGreen = (t: RawTestResult): boolean => {
		const survivor = t.historyId ? survivorByHistoryId.get(t.historyId) : undefined;
		return survivor ? survivor.status === "passed" : false;
	};

	interface Acc {
		title: string;
		exceptionType?: string;
		rootCause?: string;
		location?: string;
		sample: string;
		count: number;
		categories: Set<string>;
		suites: Set<string>;
		examples: string[];
	}
	const map = new Map<string, Acc>();
	let failuresAnalyzed = 0;
	let retriedExcluded = 0;

	for (const t of parsed) {
		if (t.status !== "failed" && t.status !== "broken") continue;

		// Drop superseded retry attempts so each test is clustered once via its surviving
		// result. Tests that failed but were retried green are excluded entirely (their
		// survivor is `passed`); tests retried but still failing are counted once.
		if (!includeRetriedAttempts && isPriorAttempt(t)) {
			if (wasRetriedGreen(t)) retriedExcluded += 1;
			continue;
		}
		failuresAnalyzed += 1;

		const sig = buildFailureSignature(t.error, { appPackages, maxFrames });
		let acc = map.get(sig.key);
		if (!acc) {
			acc = {
				title: sig.title,
				exceptionType: sig.exceptionType,
				rootCause: sig.rootCause,
				location: sig.location,
				sample: sig.sample,
				count: 0,
				categories: new Set(),
				suites: new Set(),
				examples: [],
			};
			map.set(sig.key, acc);
		}
		acc.count += 1;
		for (const c of t.categories ?? []) if (c.name) acc.categories.add(c.name);
		const suite = suiteOf(t.labels);
		if (suite) acc.suites.add(suite);
		if (acc.examples.length < maxExamples) acc.examples.push(t.name);
	}

	const sorted = [...map.values()].sort(
		(a, b) => b.count - a.count || a.title.localeCompare(b.title),
	);

	// Progressive selection: with few failures show everything; otherwise keep only
	// clusters that individually account for >= minClusterPct of all failures.
	// Clusters are sorted desc, so the qualifying ones form a prefix. Smaller clusters
	// are assumed to be derivatives/noise of the dominant ones and go to the tail.
	// `maxClusters` is always a hard ceiling.
	let selectCount: number;
	if (failuresAnalyzed <= allClustersBelow) {
		selectCount = sorted.length;
	} else {
		const minCount = (minClusterPct / 100) * failuresAnalyzed;
		let i = 0;
		while (i < sorted.length && sorted[i].count >= minCount) i += 1;
		selectCount = Math.max(MIN_SHOWN_CLUSTERS, i);
	}
	selectCount = Math.min(selectCount, maxClusters, sorted.length);

	const rest = sorted.slice(selectCount);
	const shownFailures = sorted.slice(0, selectCount).reduce((n, c) => n + c.count, 0);
	const tailFailures = rest.reduce((n, c) => n + c.count, 0);
	const pct = (n: number) => (failuresAnalyzed ? Math.round((n / failuresAnalyzed) * 1000) / 10 : 0);

	const clusters: FailureCluster[] = sorted.slice(0, selectCount).map((a) => ({
		title: a.title,
		count: a.count,
		exceptionType: a.exceptionType,
		rootCause: a.rootCause,
		location: a.location,
		categories: [...a.categories],
		suiteCount: a.suites.size,
		examples: a.examples,
		examplesTruncated: Math.max(0, a.count - a.examples.length),
		sample: a.sample,
	}));

	return {
		failuresAnalyzed,
		retriedExcluded: retriedExcluded || undefined,
		totalClusters: map.size,
		coveredPct: pct(shownFailures),
		appPackages,
		clusters,
		tail: rest.length
			? { clusters: rest.length, failures: tailFailures, pct: pct(tailFailures) }
			: undefined,
	};
}

// ---------------------------------------------------------------------------
// Compact text rendering (model-facing tool output)
// ---------------------------------------------------------------------------

/** Render a {@link ClusterReport} as compact, token-frugal text. */
export function formatClusters(r: ClusterReport): string {
	const lines: string[] = [];
	const shown = r.clusters.length;
	const showingNote =
		shown < r.totalClusters ? ` · showing ${shown} (~${r.coveredPct}% of failures)` : "";
	lines.push(
		`Java Allure failure clustering: ${r.failuresAnalyzed} failing test(s) → ` +
			`${r.totalClusters} cluster(s)${showingNote}.`,
	);
	if (r.retriedExcluded) {
		lines.push(
			`Excluded ${r.retriedExcluded} successfully-retried (flaky) failure(s); ` +
				"only surviving attempts are clustered.",
		);
	}
	lines.push(`App frames: ${r.appPackages.length ? r.appPackages.join(", ") : "(non-library)"}`);

	const pctOf = (n: number) =>
		r.failuresAnalyzed ? Math.round((n / r.failuresAnalyzed) * 1000) / 10 : 0;

	if (r.clusters.length === 0) {
		lines.push("");
		lines.push("No failing or broken tests.");
		return lines.join("\n");
	}

	r.clusters.forEach((c, i) => {
		lines.push("");
		lines.push(`[${i + 1}] ${c.count}× (${pctOf(c.count)}%) — ${c.title}`);
		if (c.location) lines.push(`    at: ${c.location}`);
		const meta: string[] = [];
		if (c.categories.length) meta.push(`categories: ${c.categories.join(", ")}`);
		meta.push(`suites: ${c.suiteCount}`);
		if (c.examples.length) {
			const extra = c.examplesTruncated ? ` (+${c.examplesTruncated} more)` : "";
			const names = c.examples
				.map((n) => (n.length > 70 ? `${n.slice(0, 69)}…` : n))
				.join(", ");
			meta.push(`e.g. ${names}${extra}`);
		}
		lines.push(`    ${meta.join(" · ")}`);
		lines.push("    trace:");
		for (const tl of c.sample.split("\n")) lines.push(`      ${tl}`);
	});

	if (r.tail) {
		lines.push("");
		lines.push(
			`+ ${r.tail.clusters} smaller cluster(s) not shown, covering ` +
				`${r.tail.failures} failure(s) (~${r.tail.pct}%).`,
		);
	}

	return lines.join("\n");
}
