import { task } from "@trigger.dev/sdk";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../../");

/**
 * Full GraphSAGE retraining pipeline.
 * Runs on the GPU rig via the 'gpu' queue (concurrency 1).
 *
 * 1. Extract graph from Postgres (TS)
 * 2. Train GraphSAGE model on GPU (Python)
 * 3. Upsert embeddings to Postgres (Python)
 */
export const graphRetrain = task({
  id: "ml.graph-retrain",
  queue: {
    name: "gpu",
  },
  run: async (payload: { epochs?: number; modelVersion?: string } = {}) => {
    const dbDir = path.join(ROOT_DIR, "packages/db");
    const mlDir = path.join(ROOT_DIR, "services/ml-training");
    const pythonPath = path.join(mlDir, ".venv/bin/python");
    const graphFile = path.join(ROOT_DIR, "graph.json");
    const embeddingsFile = path.join(mlDir, "embeddings.json");

    // Sanitize modelVersion if provided (alphanumeric, underscore, dash)
    const sanitizedVersion = payload.modelVersion?.replace(/[^a-zA-Z0-9_-]/g, "");

    console.log("Starting graph extraction...");
    await runCommand("pnpm", ["extract-graph", "--output", graphFile], dbDir);

    console.log("Starting GraphSAGE training...");
    const trainArgs = [
      "-m", "procur_ml.train",
      "--graph", graphFile,
      "--output", embeddingsFile,
    ];
    if (payload.epochs && Number.isInteger(payload.epochs)) {
      trainArgs.push("--epochs", payload.epochs.toString());
    }
    if (sanitizedVersion) {
      trainArgs.push("--model-version", sanitizedVersion);
    }
    await runCommand(pythonPath, trainArgs, mlDir);

    console.log("Starting embedding upsert...");
    await runCommand(pythonPath, ["-m", "procur_ml.upsert", "--embeddings", embeddingsFile], mlDir);

    return {
      status: "completed",
      graphFile,
      embeddingsFile,
      modelVersion: sanitizedVersion,
    };
  },
});

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Avoid shell: true for security.
    // pnpm on Unix is a symlink to a JS file, so we may need to use full path or 'node' if it fails.
    // However, Trigger.dev environment usually has pnpm in PATH.
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
