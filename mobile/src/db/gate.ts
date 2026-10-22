/**
 * Lets any number of `shared` users run together, and lets `exclusive` run alone: it waits for the
 * running users to finish and holds back every user that arrives meanwhile. A restore swaps the
 * database file under this, so no store call may be midway through it.
 */
export interface Gate {
  shared<R>(fn: () => Promise<R>): Promise<R>;
  exclusive<R>(fn: () => Promise<R>): Promise<R>;
}

export function createGate(): Gate {
  let running = 0;
  let writer: Promise<void> | null = null;
  const idle: Array<() => void> = [];

  const settle = () => {
    if (running === 0) for (const wake of idle.splice(0)) wake();
  };

  async function shared<R>(fn: () => Promise<R>): Promise<R> {
    while (writer !== null) await writer;
    running++;
    try {
      return await fn();
    } finally {
      running--;
      settle();
    }
  }

  async function exclusive<R>(fn: () => Promise<R>): Promise<R> {
    while (writer !== null) await writer;
    let release!: () => void;
    writer = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      if (running > 0) await new Promise<void>((resolve) => idle.push(resolve));
      return await fn();
    } finally {
      writer = null;
      release();
    }
  }

  return { shared, exclusive };
}
