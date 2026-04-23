export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => void;
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
  child: (bindings: Record<string, unknown>) => Logger;
};

type Event = {
  _time: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
};

const AXIOM_INGEST_URL = 'https://api.axiom.co/v1/datasets';

async function shipToAxiom(events: Event[]): Promise<void> {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  if (!token || !dataset) return;

  try {
    await fetch(`${AXIOM_INGEST_URL}/${dataset}/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(events),
      keepalive: true,
    });
  } catch {
    // Axiom failure must not crash the request
  }
}

function emit(level: LogLevel, message: string, bindings: Record<string, unknown>): void {
  const event: Event = {
    _time: new Date().toISOString(),
    level,
    message,
    ...bindings,
  };

  const line = JSON.stringify(event);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }

  void shipToAxiom([event]);
}

function build(bindings: Record<string, unknown>): Logger {
  return {
    debug: (msg, ctx) => emit('debug', msg, { ...bindings, ...ctx }),
    info: (msg, ctx) => emit('info', msg, { ...bindings, ...ctx }),
    warn: (msg, ctx) => emit('warn', msg, { ...bindings, ...ctx }),
    error: (msg, ctx) => emit('error', msg, { ...bindings, ...ctx }),
    child: (extra) => build({ ...bindings, ...extra }),
  };
}

export const log: Logger = build({});
