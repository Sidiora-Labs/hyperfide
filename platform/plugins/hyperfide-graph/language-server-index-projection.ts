/** Task 1.3 projection: append element to the Index panel and dispose on unmount. */
export function createLanguageServerIndexStatus(
  daemonUrl: string,
  repository: string,
) {
  const element = document.createElement("div");
  element.setAttribute("role", "status");
  element.textContent = "Language server: stopped";
  let disposed = false;
  const controller = new AbortController();
  const refresh = async () => {
    let status = "stopped";
    try {
      const url = new URL("/language-server/status", daemonUrl);
      url.searchParams.set("repository", repository);
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok && (await response.json()).status === "running")
        status = "running";
    } catch {
      /* Missing binary and disconnected daemons are a quiet stopped state. */
    }
    if (!disposed) element.textContent = `Language server: ${status}`;
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 5000);
  return {
    element,
    refresh,
    dispose() {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      element.remove();
    },
  };
}
