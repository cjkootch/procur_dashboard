# ML Tasks (GPU Worker)

This service provides Trigger.dev tasks for the ML pipeline that are designed to run on a dedicated GPU rig.

## Hooking up your GPU rig

To hook up your GPU rig to Procur, follow these steps on the rig:

1.  **Clone the repository** (if not already done).
2.  **Ensure prerequisites are met**:
    - Node.js >= 20
    - pnpm >= 9
    - Python >= 3.10
3.  **Install dependencies**:
    ```bash
    pnpm install
    ```
4.  **Set up the Python environment**:
    ```bash
    cd services/ml-training
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -e '.[bge]'  # Install base + BGE-M3 dependencies
    ```
5.  **Configure environment variables**:
    Create a `.env.local` in the root of the repo with your `TRIGGER_SECRET_KEY` and `DATABASE_URL`.
6.  **Start the Trigger.dev worker**:
    ```bash
    cd services/ml-tasks
    npx trigger.dev@latest dev
    ```

Once the worker is running, it will automatically register the following tasks and wait for jobs:
- `ml.graph-retrain`: Full GraphSAGE training pipeline.
- `ml.entity-embed`: Inductive embedding for new entities.
- `ml.bge-m3-embed`: Multilingual text embedding.

All tasks are routed to a `gpu` queue with `concurrencyLimit: 1` to ensure serialized access to the GPU.

## Project Structure

- `src/trigger/`: Trigger.dev task definitions.
- `trigger.config.ts`: Configuration for the `gpu` queue and project settings.
