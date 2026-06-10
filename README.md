# pi-agent-extensions

A collection of extensions for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

Each extension registers slash commands and/or LLM-callable tools. Drop an
extension into `~/.pi/agent/extensions/` (or point pi at it) and it is
auto-discovered.

## Extensions

### `usage-cost.ts`
Adds a `/usage` slash command (alias `/cost`) and a `session_cost` tool that
report the current session's cumulative token usage (input / output / cache
read / cache write / total), cost in USD, and current context-window usage.

### `allure-java-analyzer/`
A focused extension that clusterizes failures in an
[Allure 3](https://github.com/allure-framework/allure3) report produced by
**Java** test frameworks (JUnit / TestNG). It reads the raw
`data/test-results/*.json` files, groups failing/broken tests by a normalized
Java error signature (full exception chain + root cause + top application stack
frame), and returns a compact set of root-cause clusters via the
`cluster_java_allure_failures` tool. See
[`allure-java-analyzer/README.md`](allure-java-analyzer/README.md) for details.

## License

See [LICENSE](LICENSE).
