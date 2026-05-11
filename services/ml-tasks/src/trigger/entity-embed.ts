import { task } from "@trigger.dev/sdk";
import spawn from "cross-spawn";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../../");
const IS_WINDOWS = process.platform === "win32";
const VENV_PYTHON_REL = IS_WINDOWS ? ".venv/Scripts/python.exe" : ".venv/bin/python";

/**
 * Inductive entity embedding.
 * Embeds a single entity without retraining the full model.
 * Runs on the GPU rig (or CPU if no GPU available, but rig has one).
 */
export const entityEmbed = task({
  id: "ml.entity-embed",
  queue: {
    name: "gpu",
  },
  run: async (payload: { entitySlug: string; checkpointDir?: string }) => {
    // STRICT SANITIZATION: alphanumeric, colon, dash only. Prevents shell injection and traversal.
    if (!/^[a-zA-Z0-9:-]+$/.test(payload.entitySlug)) {
      throw new Error(`Invalid entitySlug: ${payload.entitySlug}`);
    }

    const dbDir = path.join(ROOT_DIR, "packages/db");
    const mlDir = path.join(ROOT_DIR, "services/ml-training");
    const pythonPath = path.join(mlDir, VENV_PYTHON_REL);
    // Slug is now safe to use in filename
    const singleGraphFile = path.join(ROOT_DIR, `single-${payload.entitySlug}.json`);

    console.log(`Extracting neighborhood for ${payload.entitySlug}...`);
    await runCommand(
      "pnpm",
      ["extract-graph", `--single-entity=${payload.entitySlug}`, "--output", singleGraphFile],
      dbDir
    );

    console.log(`Inductively embedding ${payload.entitySlug}...`);
    const embedArgs = [
      "-m", "procur_ml.embed_entity",
      "--graph", singleGraphFile,
      "--upsert",
    ];
    if (payload.checkpointDir) {
      // Strict relative-path allowlist: each segment must match
      // [a-zA-Z0-9_-]+ and the assembled path must not start with /,
      // contain `..`, or have empty segments. Earlier version stripped
      // characters but didn't reject `..` outright, which after
      // path.resolve() in the Python side could escape the intended
      // checkpoints dir.
      const dir = payload.checkpointDir.trim();
      const segmentRe = /^[a-zA-Z0-9_-]+$/;
      const segments = dir.split("/").filter(Boolean);
      const valid =
        !dir.startsWith("/") &&
        segments.length > 0 &&
        segments.every((s) => s !== ".." && segmentRe.test(s));
      if (!valid) {
        throw new Error(
          `Invalid checkpointDir: ${payload.checkpointDir}. Use a relative path of [a-zA-Z0-9_-] segments only (no .. or leading /).`,
        );
      }
      embedArgs.push("--checkpoint-dir", segments.join("/"));
    }
    await runCommand(pythonPath, embedArgs, mlDir);

    return {
      status: "completed",
      entitySlug: payload.entitySlug,
    };
  },
});

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // cross-spawn handles Windows .cmd/.bat resolution and the Node 20+
    // shell-spawn CVE mitigation transparently. Args are validated against
    // strict allowlists or built from path.join, so there's no shell-meta
    // injection surface on either platform.
    const proc = spawn(command, args, { cwd, stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command ${command} ${args.join(" ")} failed with code ${code}`));
    });
    proc.on("error", (err) => {
      reject(new Error(`Failed to start command ${command}: ${err.message}`));
    });
  });
}
