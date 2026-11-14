/**
 * Return a Git remote URL without user-info credentials.
 *
 * Git accepts both regular URLs (`https://user:password@example/...`) and
 * scp-like remotes (`user@example:repo`).  Remote URLs discovered on a host
 * cross an authenticated host/server boundary, so neither form may carry
 * the local credential material into a response.
 */
export function sanitizeGitOriginUrl(value: string): string {
  const input = value.trim();
  if (input === "") return input;

  try {
    const parsed = new URL(input);
    if (parsed.username === "" && parsed.password === "") return input;

    // Preserve the spelling of the URL (including its path and query) while
    // removing the complete authority user-info prefix.  URL#toString would
    // normalize otherwise harmless remote spellings.
    const schemeEnd = input.indexOf("://");
    const authorityStart = schemeEnd + 3;
    const authorityLength = input.slice(authorityStart).search(/[/?#]/u);
    const end =
      authorityLength === -1 ? input.length : authorityStart + authorityLength;
    const at = input.lastIndexOf("@", end);
    if (schemeEnd >= 0 && at >= authorityStart) {
      return `${input.slice(0, authorityStart)}${input.slice(at + 1)}`;
    }

    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // A malformed URL should not cause discovery to fail.  Handle the
    // authority and scp-like forms conservatively without rewriting paths.
    const authority = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/u.exec(
      input,
    );
    if (authority) {
      const at = authority[2].lastIndexOf("@");
      if (at >= 0) {
        return `${authority[1]}${authority[2].slice(at + 1)}${authority[3]}`;
      }
    }
    return input.replace(/^([^/\s@]+)@(?=[^/\s:]+:)/u, "");
  }
}
