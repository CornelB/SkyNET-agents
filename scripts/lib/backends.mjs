// argv for each backend. Ollama runs through codex --oss so it gets codex's harness and sandbox.
// agy takes the prompt as -p=<text> (it does not read stdin; the = keeps a leading "-" from reading as a flag) and keeps slash commands on,
// because --disable-slash-commands turns plan mode off.
// Ollama gets its own empty CODEX_HOME (ossHome): the user's codex config, MCP servers, skills
// and AGENTS.md swamp a local model, which then calls tools that do not exist.
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
  throw new Error(`unknown backend ${backend}`);
}
