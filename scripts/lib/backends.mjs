// argv for each backend. Ollama runs through codex --oss so it gets codex's harness and sandbox.
// agy takes the prompt as the -p value (it does not read stdin) and keeps slash commands on,
// because --disable-slash-commands turns plan mode off.
export function buildInvocation(backend, { mode, cwd, promptFile, outFile, prompt, model }) {
  if (backend === "codex" || backend === "ollama") {
    const args = ["exec", "--skip-git-repo-check", "-C", cwd, "-s", mode === "write" ? "workspace-write" : "read-only", "-o", outFile];
    if (backend === "ollama") {
      if (!model) {
        throw new Error("ollama model not configured");
      }
      args.push("--oss", "--local-provider", "ollama", "-m", model);
    }
    return { cmd: "codex", args: [...args, "-"], stdinFile: promptFile };
  }
  if (backend === "agy") {
    const args = ["--output-format", "text", "--mode", mode === "write" ? "accept-edits" : "plan", "--print-timeout", "0s"];
    if (mode === "write") {
      args.push("--sandbox");
    }
    return { cmd: "agy", args: [...args, "-p", prompt], stdoutFile: outFile };
  }
  throw new Error(`unknown backend ${backend}`);
}
