# allure-analyzer (Java)

A pi extension that does **one thing**: clusterize the failures in an
[Allure 3](https://github.com/allure-framework/allure3) report produced by
**Java** test frameworks (JUnit / TestNG).

> ⚠️ Java-only: clustering assumes Java stack traces (`Caused by:`,
> `at pkg.Class.method(File.java:line)`). Reports from other languages will not
> cluster meaningfully.

It reads the raw `data/test-results/*.json` files, takes the failing/broken tests,
and groups them by a normalized **Java** error signature so that "the same root
cause across N tests" collapses into a single cluster. The output is deliberately
compact so it does not bloat the context of an LLM consuming it.

## What it does (and what it intentionally does not)

- **Clusterizes failures** by the whole exception chain (the thrown exception plus
  every `Caused by:`) and the top application stack frame. Dynamic noise (UUIDs,
  session ids, hex ids, URLs, timestamps, numbers, quoted literals) is stripped so
  structurally identical errors share a key.
- Each cluster carries a count, the root cause, the throw location, a few example
  test names, and a representative trace excerpt (full exception/cause messages +
  application stack frames).
- **Retries are collapsed.** Only the surviving attempt of each test is clustered.
  Failures that ultimately passed on retry ("successfully retried" / flaky) are
  excluded by default and reported as `retriedExcluded`; a test retried but still
  failing is counted once instead of once per attempt. Set `includeRetriedAttempts`
  to `true` for legacy per-attempt counting.
- It does **not** produce execution summaries, pass-rate stats, skip/flaky/slowest
  analytics, per-tag breakdowns, or any interactive UI. Just clusters.

## Usage

Run pi from inside an extracted `allure-report` folder (or pass a path), then ask
the agent to cluster the failures — it calls the tool below.

### Tool: `cluster_java_allure_failures`

Clusters the failing/broken tests of a **Java** Allure 3 report by error signature
and returns the distinct clusters, highest-impact first.

#### Parameters

All parameters are optional.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `reportDir` | `string` | current working dir | Allure report dir (contains `data/test-results` and `index.html`). Also accepts the `data/` or `test-results/` folder directly. |
| `minClusterPct` | `number` (0–100) | `5` | **Progressive output.** Drop clusters that individually cover less than this percent of all failing tests (they are usually derivatives of the dominant clusters); dropped clusters go to `tail`. |
| `allClustersBelow` | `number` | `20` | When the total failing tests is at or below this, show **all** clusters regardless of `minClusterPct` (few failures → full detail). |
| `maxClusters` | `number` | `20` | Hard ceiling on shown clusters, applied **after** the `minClusterPct` selection. |
| `maxFrames` | `number` | `8` | Maximum application stack frames kept per exception in each cluster's trace. |
| `maxExamples` | `number` | `3` | Maximum example test names listed per cluster. |
| `includeRetriedAttempts` | `boolean` | `false` | Include superseded retry attempts. By default only each test's surviving attempt is clustered, so flaky failures that passed on retry are excluded and retried-then-failed tests are counted once. Set `true` for legacy per-attempt counting. |
| `appPackages` | `string[]` | `ALLURE_APP_PACKAGES` env, else non-library frames | Package prefixes (e.g. `["org.example"]`) whose stack frames are kept in the trace. Matched on a package boundary (`org.example` matches `org.example.Foo`, not `org.exampleother.Foo`). Does **not** affect how tests are grouped. |

#### Returns

- **`content`** — a compact text rendering of the clusters (what the model reads).
- **`details`** — the structured `ClusterReport` (see below) for programmatic use.
- On error (e.g. no report found) it returns `isError: true` with a short message.

#### Progressive output (per-cluster minimum share)

The tool is progressive by default, so a plain "cluster the failures" prompt scales
from tiny to huge runs without flooding the context:

- **Few failures** (`failuresAnalyzed <= allClustersBelow`, default 20) → every
  cluster is returned in full.
- **Many failures** → only clusters that **individually** account for at least
  `minClusterPct` (default 5%) of all failures are returned. Smaller clusters are
  assumed to be derivatives/noise of the dominant ones and are collapsed into a
  single `tail` summary (`{ clusters, failures, pct }`); `coveredPct` reports how
  much of the failures the shown clusters represent. At least one cluster is always
  shown, and `maxClusters` still caps the count.

Example distribution — cluster shares `55%, 35%, 4%, 4%, 2%` with the default 5%
threshold: only the **55% and 35%** clusters are kept (covering 90%); the three
small clusters (4/4/2%) collapse into the tail, since they are most likely
derivatives of the top two.

On the bundled 545-failure run (35 clusters) the default returns the **top 4
clusters (~86%)** and a one-line tail for the other 31 — roughly a 6× smaller
payload than dumping all clusters. Lower `minClusterPct` (e.g. `0`) to widen, raise
it (e.g. `10`) to tighten.

#### Example prompts

Each maps to a single `cluster_java_allure_failures` call:

- "Cluster the failures in this Allure report." (progressive by default)
- "What are the distinct root causes of this run? Group them."
- "Cluster the failures and keep `com.acme` frames in the traces (`appPackages: [\"com.acme\"]`)."
- "Only show clusters that each cover ≥10% of failures (`minClusterPct: 10`)."
- "Show every cluster, even singletons (`minClusterPct: 0`, `maxClusters: 100`)."
- "Are these failures one bug or many? Cluster them and explain each root cause."

## Output data structure

`clusterFailures()` (and the tool's `details`) returns a `ClusterReport`:

```jsonc
{
  "failuresAnalyzed": 0,        // failing/broken tests considered (surviving attempts only)
  "retriedExcluded": 0,         // failed prior attempts dropped because the test passed on retry (omitted when 0)
  "totalClusters": 0,           // distinct clusters found (before selection)
  "coveredPct": 0.0,            // % of all failures covered by the shown clusters
  "appPackages": ["string"],    // resolved app-package prefixes used for traces
  "tail": {                     // omitted when every cluster is shown
    "clusters": 0,              // number of small clusters not shown
    "failures": 0,              // failing tests they account for
    "pct": 0.0                  // % of all failures in the tail
  },

  "clusters": [                 // shown clusters, sorted by count desc (progressive)
    {
      "title": "string",        // one-liner, e.g. "RuntimeException: ...  ⇐  InvalidFormatException: ..."
      "count": 0,               // failing/broken tests in this cluster
      "exceptionType": "string?", // FQ type of the thrown (outermost) exception
      "rootCause": "string?",   // deepest "SimpleType: message" (only when a Caused-by chain exists)
      "location": "string?",    // top application frame pkg.Class.method(File.java:line)
      "categories": ["string"], // Allure category names
      "suiteCount": 0,          // distinct suites impacted (count only, not the list)
      "examples": ["string"],   // up to maxExamples test names
      "examplesTruncated": 0,   // count - examples.length
      "sample": "string"        // full exception/cause messages + application stack frames
    }
  ]
}
```

Optional fields (`?`) are omitted from JSON when absent (e.g. `rootCause` only
appears for errors with a `Caused by:` chain).

## How clustering works

1. Parse the Java stack trace into its exception chain (thrown → `Caused by:` → …),
   capturing each exception's type, message, and stack frames.
2. Build a signature from **every** exception in the chain (`type + full
   normalized message`), anchored on the top **application** frame
   (`pkg.Class.method(File.java:line)`), skipping JDK/library frames. This keeps
   distinct throw sites that share a message (e.g. several `NullPointerException`s)
   in separate clusters.
3. Normalize messages: `UUID → <uuid>`, `http(s)://… → <url>`, timestamps → `<ts>`,
   long hex → `<hex>`, `"…" → "<v>"`, then numbers **by meaning** — amounts/decimals
   → `<num>`, id-keyed values (`brandId=34`) and long integers (≥4 digits) → `<id>`,
   while **short integers (1–3 digits) are kept** so values like HTTP status codes
   (`200` vs `401` vs `500`) keep distinct clusters apart — collapse whitespace, lowercase.
4. Tests with the same signature land in one cluster, sorted by impact (count).

## Layout

```
allure-java-analyzer/
├── index.ts     # registers the single `cluster_java_allure_failures` tool
├── cluster.ts   # parse Java traces, build the signature, cluster, render compact text
└── README.md
```
