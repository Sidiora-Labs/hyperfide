export function buildAutomationEditThreadPrompt({
  name,
  projectId,
  automationId,
}: {
  name: string;
  projectId: string;
  automationId: string;
}): string {
  return `Edit the hyperfide-platform automation ${JSON.stringify(name)} (ID ${automationId}) in project ${projectId}. I want to `;
}
