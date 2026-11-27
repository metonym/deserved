// The variables a coding agent sets. Each tool keeps its own copy, since
// a package has no runtime dependencies.
const AGENT_ENV = [
  "AGENT",
  "AI_AGENT",
  "CLAUDECODE",
  "CODEX_CI",
  "CODEX_THREAD_ID",
] as const;

type Env = Readonly<Record<string, string | undefined>>;

// Empty or `0` is a person saying "not an agent" without unsetting it.
export const isAgent = (env: Env): boolean =>
  AGENT_ENV.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "0";
  });
