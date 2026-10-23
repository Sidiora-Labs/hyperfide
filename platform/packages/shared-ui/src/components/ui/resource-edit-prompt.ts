function quoteResourceName(name: string): string {
  return JSON.stringify(name);
}

export function buildPluginEditThreadPrompt({
  name,
  path,
}: {
  name: string;
  path: string;
}): string {
  return `Edit the hyperfide-platform plugin ${quoteResourceName(name)} at ${path}. I want to `;
}

export function buildSkillEditThreadPrompt({
  id,
  name,
  path,
}: {
  id: string;
  name: string;
  path: string;
}): string {
  return `Edit the hyperfide skill ${quoteResourceName(name)} (ID ${id}) at ${path}. Inspect it with hyperfide skill show ${id} --json and pass that revision to hyperfide skill update when saving. I want to `;
}
