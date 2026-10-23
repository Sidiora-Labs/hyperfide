kind: decision

Question: Should worker injection use a repository file and a graph-owned bridge adapter until task 1.3 merges?

Options: repository-file (recommended), host-setting.

Ask: 3; recommendation is .codegraph/worker-injection.json with enabled:false and graph-lifecycle-projection.ts wired into both bridges.

Blocked: nothing; decision proceeds on recommendation.

Finished anyway: provider MCP hook, graph detection and provider session integration.
