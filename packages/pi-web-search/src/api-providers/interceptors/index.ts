import type { GitHubInterceptorConfig } from "../../config.ts";
import { GitHubInterceptor, resolveGitHubOptions } from "./github.ts";
import type { UrlInterceptor } from "./types.ts";

export {
  DEFAULTS as GITHUB_INTERCEPTOR_DEFAULTS,
  GITHUB_TOKEN_ENV_VAR,
  GitHubInterceptor,
  type GitHubInterceptorOptions,
  type GitHubUrlInfo,
  parseGitHubUrl,
  type ResolvedGitHubOptions,
  resolveGitHubCloneDir,
  resolveGitHubOptions,
} from "./github.ts";
export type { UrlInterceptor } from "./types.ts";

let activeKey: string | undefined;
let activeInterceptors: UrlInterceptor[] = [];
let activeGitHubInterceptor: GitHubInterceptor | undefined;

export function getInterceptors(
  config: boolean | GitHubInterceptorConfig | undefined,
  onGhHint?: () => void,
): readonly UrlInterceptor[] {
  const resolved = resolveGitHubOptions(config, undefined);
  const key = JSON.stringify(resolved);
  if (key === activeKey) {
    activeGitHubInterceptor?.setGhHintHandler(onGhHint);
    return activeInterceptors;
  }

  activeGitHubInterceptor?.reset();
  activeKey = key;
  activeGitHubInterceptor = resolved.enabled
    ? new GitHubInterceptor({ ...resolved, onGhHint })
    : undefined;
  activeInterceptors = activeGitHubInterceptor ? [activeGitHubInterceptor] : [];
  return activeInterceptors;
}

export function clearCloneCache(): void {
  activeGitHubInterceptor?.reset();
}
