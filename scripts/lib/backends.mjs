import { fileURLToPath } from "node:url";

// argv for each backend. Ollama runs through codex --oss so it gets codex's harness and sandbox.
// agy takes the prompt as -p=<text> (it does not read stdin; the = keeps a leading "-" from reading as a flag).
// agy runs with --sandbox (read-only shell, no network) and this plugin's own permissions file per mode
// (--settings replaces the user's agy permissions for that run; model and project still come from the user's file).
// Read jobs: read files only, the rest denied. Write jobs: read, write and shell; URL reads and MCP denied.
// A tool with no rule ends a headless run with no output, so leaving the sandbox (no rule) ends a write job.
// Never deny unsandboxed(*) in the write file: that rule also denies every sandboxed shell command.
// No --mode plan: it waits for a Proceed click and never does the task.
const AGY_SETTINGS = {
  read: fileURLToPath(new URL("../agy-settings-read.json", import.meta.url)),
  write: fileURLToPath(new URL("../agy-settings-write.json", import.meta.url))
};
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
        throw new Error("OLLAMA_CODING_MODEL not set");
      }
      if (!ossHome) {
        throw new Error("ollama needs ossHome");
      }
      // model_provider=ollama: --oss alone leaves the turn on the openai provider, and codex 0.166
      // refuses it with modelProviderMismatch, even in an empty CODEX_HOME.
      args.push("--oss", "--local-provider", "ollama", "-c", "model_provider=ollama", "-m", model);
      return { cmd: "codex", args: [...args, "-"], stdinFile: promptFile, env: { CODEX_HOME: ossHome } };
    }
    return { cmd: "codex", args: [...args, "-"], stdinFile: promptFile };
  }
  if (backend === "agy") {
    const write = mode === "write";
    const args = ["--output-format", "text", ...(write ? ["--mode", "accept-edits"] : []), "--print-timeout", "0s", "--sandbox", "--settings", AGY_SETTINGS[write ? "write" : "read"]];
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
