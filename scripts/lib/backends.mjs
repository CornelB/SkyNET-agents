// argv for each backend. Ollama runs through codex --oss so it gets codex's harness and sandbox.
// agy takes the prompt as -p=<text> (it does not read stdin; the = keeps a leading "-" from reading as a flag) and keeps slash commands on,
// because --disable-slash-commands turns plan mode off.
// Ollama gets its own empty CODEX_HOME (ossHome): the user's codex config, MCP servers, skills
// and AGENTS.md swamp a local model, which then calls tools that do not exist.
// OpenRouter runs through opencode. Free endpoints may log prompts, so secrets stay out of reach.
const OPENCODE_JOB_CONFIG = {
  permission: {
    read: { "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
    external_directory: "deny",
    question: "deny"
  }
};

export function buildInvocation(backend, { mode, cwd, promptFile, outFile, prompt, model, ossHome }) {
  if (backend === "codex" || backend === "ollama") {
    const args = ["exec", "--skip-git-repo-check", "-C", cwd, "-s", mode === "write" ? "workspace-write" : "read-only", "-o", outFile];
    if (backend === "ollama") {
      if (!model) {
        throw new Error("ollama model not configured");
      }
      if (!ossHome) {
        throw new Error("ollama needs ossHome");
      }
      args.push("--oss", "--local-provider", "ollama", "-m", model);
      return { cmd: "codex", args: [...args, "-"], stdinFile: promptFile, env: { CODEX_HOME: ossHome } };
    }
    return { cmd: "codex", args: [...args, "-"], stdinFile: promptFile };
  }
  if (backend === "agy") {
    const args = ["--output-format", "text", "--mode", mode === "write" ? "accept-edits" : "plan", "--print-timeout", "0s"];
    if (mode === "write") {
      args.push("--sandbox");
    }
    return { cmd: "agy", args: [...args, `-p=${prompt}`], stdoutFile: outFile };
  }
  if (backend === "openrouter") {
    if (!model) {
      throw new Error("openrouter model not configured");
    }
    // --standalone: a private server that sees this job's cwd and env, not the background service.
    // --auto approves "ask" rules, so the job config denies what must stay local: .env files, paths
    // outside the tree, and questions nobody is there to answer.
    const args = ["run", "--standalone", "-m", `openrouter/${model}`, "--agent", mode === "write" ? "build" : "plan", "--auto", "--", prompt];
    return { cmd: "opencode", args, stdoutFile: outFile, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_JOB_CONFIG) } };
  }
  throw new Error(`unknown backend ${backend}`);
}
