/**
 * allure-analyzer — failure clusterization for Allure 3 reports.
 *
 * Exposes a single LLM-callable tool, `cluster_allure_failures`, that groups the
 * failing/broken tests of an Allure report into a handful of root-cause clusters.
 * Output is deliberately compact to avoid bloating the caller's context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type ClusterOptions, clusterFailures, formatClusters } from "./cluster";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "cluster_java_allure_failures",
		label: "Cluster Java Allure Failures",
		description:
			"Cluster the failing/broken tests of an Allure 3 report produced by a JAVA test " +
			"framework (JUnit/TestNG; stack traces must be Java) by a normalized Java " +
			"error signature (full exception chain + root cause + top application stack frame). " +
			"Returns the distinct failure clusters, each with a count, location, example tests, " +
			"and a representative trace excerpt. Use it to collapse many failures into a few " +
			"root causes.",
		promptSnippet: "Cluster Java Allure test failures by root cause.",
		promptGuidelines: [
			"Use cluster_java_allure_failures when the user asks to cluster/group failures or " +
				"find the distinct root causes of a Java (JUnit/TestNG) Allure test run. It assumes " +
				"Java stack traces. Default reportDir to the current working directory when not specified.",
		],
		parameters: Type.Object({
			reportDir: Type.Optional(
				Type.String({
					description:
						"Path to the Allure report directory (containing data/test-results). " +
						"Also accepts the data/ or test-results/ folder directly. Defaults to cwd.",
				}),
			),
			minClusterPct: Type.Optional(
				Type.Number({
					description:
						"Progressive output (0–100): drop clusters that individually cover less than this " +
						"percent of all failing tests — they are usually derivatives of the dominant " +
						"clusters — and summarize them in `tail`. Default 5.",
				}),
			),
			allClustersBelow: Type.Optional(
				Type.Number({
					description:
						"When the total number of failing tests is at or below this, show ALL clusters " +
						"regardless of `minClusterPct` (few failures → full detail). Default 20.",
				}),
			),
			maxClusters: Type.Optional(
				Type.Number({
					description:
						"Hard ceiling on shown clusters, applied after the minClusterPct selection. Default 20.",
				}),
			),
			maxFrames: Type.Optional(
				Type.Number({
					description:
						"Max application stack frames kept per exception in each cluster's trace. Default 8.",
				}),
			),
			maxExamples: Type.Optional(
				Type.Number({ description: "Max example test names listed per cluster. Default 3." }),
			),
			includeRetriedAttempts: Type.Optional(
				Type.Boolean({
					description:
						"Include superseded retry attempts. By default (false) only each test's surviving " +
						"attempt is clustered, so failures that ultimately passed on retry (flaky) are excluded " +
						"and retried-then-failed tests are counted once. Set true for legacy per-attempt counting.",
				}),
			),
			appPackages: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Package prefixes (e.g. ["org.example"]) whose Java stack frames are kept in ' +
						"the trace excerpt. Defaults to the ALLURE_APP_PACKAGES env var; if empty, any " +
						"non-library frame is kept. Does not affect how tests are grouped.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const opts: ClusterOptions = {
				reportDir: params.reportDir ?? ctx.cwd,
				minClusterPct: params.minClusterPct,
				allClustersBelow: params.allClustersBelow,
				maxClusters: params.maxClusters,
				maxFrames: params.maxFrames,
				maxExamples: params.maxExamples,
				includeRetriedAttempts: params.includeRetriedAttempts,
				appPackages: params.appPackages,
			};
			try {
				const report = clusterFailures(opts);
				return {
					content: [{ type: "text", text: formatClusters(report) }],
					details: report,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to cluster report: ${(err as Error).message}` }],
					isError: true,
					details: {},
				};
			}
		},
	});
}
