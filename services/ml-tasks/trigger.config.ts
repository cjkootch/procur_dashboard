import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_ml_gpu_tasks",
  runtime: "node-22",
  logLevel: "info",
  maxDuration: 7200, // 2 hours for full training
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 10_000,
      maxTimeoutInMs: 120_000,
      randomize: true,
    },
  },
  // Dedicated queue for GPU tasks to ensure serialized access to the rig
  queues: {
    gpu: {
      concurrencyLimit: 1,
    },
  },
  dirs: ["./src/trigger"],
});
