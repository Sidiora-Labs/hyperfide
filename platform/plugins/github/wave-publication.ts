export interface WavePullRequest {
  feature: string;
  wave: number;
  branch: string;
  base: string;
  summary: string;
}
export interface WavePullRequestClient {
  createPullRequest(input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ url: string }>;
}

// The configured GitHub plugin client owns authentication and transport.
export function wavePullRequests(client: WavePullRequestClient, repo: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error("Invalid GitHub repository");
  return (wave: WavePullRequest) =>
    client.createPullRequest({
      repo,
      head: wave.branch,
      base: wave.base,
      title: `${wave.feature}: wave ${wave.wave}`,
      body: wave.summary,
    });
}
