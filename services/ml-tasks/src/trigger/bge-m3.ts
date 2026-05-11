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
 * BGE-M3 Multilingual Embedding.
 * Generates dense text embeddings for entities and web summaries.
 */
export const bgeM3Embed = task({
  id: "ml.bge-m3-embed",
  queue: {
    name: "gpu",
  },
  run: async () => {
    const dbDir = path.join(ROOT_DIR, "packages/db");
    const mlDir = path.join(ROOT_DIR, "services/ml-training");
    const pythonPath = path.join(mlDir, VENV_PYTHON_REL);
    const textsFile = path.join(ROOT_DIR, "bge-texts.json");
    const embeddingsFile = path.join(mlDir, "bge-embeddings.json");

    console.log("Extracting BGE texts...");
    await runNodeScript("src/extract-bge-texts.ts", ["--output", textsFile], dbDir);

    console.log("Running BGE-M3 embedding (GPU)...");
    await runCommand(
      pythonPath,
      ["-m", "procur_ml.bge_m3", "embed", "--input", textsFile, "--output", embeddingsFile],
      mlDir
    );

    console.log("Upserting BGE embeddings...");
    await runNodeScript("src/upsert-bge-embeddings.ts", ["--input", embeddingsFile], dbDir);

    return {
      status: "completed",
    };
  },
});

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
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

// Run a tsx script via the current node binary (process.execPath). Avoids
// pnpm.cmd / cmd.exe — the Trigger.dev v4 worker on Windows can't reach
// cmd.exe under any spawn config we tried.
function runNodeScript(scriptRelPath: string, args: string[], cwd: string): Promise<void> {
  return runCommand(process.execPath, ["--import", "tsx", scriptRelPath, ...args], cwd);
}
