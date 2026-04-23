export interface LifeContextRunArgs {
  cwd: string;
  extraArgs: string[];
}

export type GetLifeContextRunArgs = (agentName: string) => LifeContextRunArgs | null;

export interface ResolvedSpawn {
  cwd: string;
  extraArgs: string[] | undefined;
}

/**
 * Resolve the CLI spawn parameters (cwd + extraArgs) for a send.
 *
 * For a life-context topic agent, the CWD is switched to the topic directory
 * and the life-context extras (notably `--add-dir <_identity>`) are *appended*
 * to the gateway tool args. Appending (not replacing) preserves
 * `--allowed-tools` — without it, adding `--add-dir` would silently strip
 * `--dangerously-skip-permissions` at the claude-cli layer and leave the
 * agent with no allowlist, denying Bash(gh:*), Bash(git:*), etc.
 *
 * For all other agents, the project cwd and gateway-default tool args are
 * used unchanged.
 */
export function resolveLifeContextRun(
  getLifeContextRunArgs: GetLifeContextRunArgs,
  agentName: string | undefined,
  defaultCwd: string,
  defaultExtraArgs: string[],
): ResolvedSpawn {
  if (agentName) {
    const run = getLifeContextRunArgs(agentName);
    if (run) {
      return { cwd: run.cwd, extraArgs: [...defaultExtraArgs, ...run.extraArgs] };
    }
  }
  return {
    cwd: defaultCwd,
    extraArgs: defaultExtraArgs.length > 0 ? defaultExtraArgs : undefined,
  };
}
