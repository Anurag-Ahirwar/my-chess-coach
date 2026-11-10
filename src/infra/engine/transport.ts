/**
 * A line-based connection to one engine process. The browser uses a Web Worker
 * (workerTransportFactory); tests use a child process or a fake.
 */
export interface EngineTransportHandlers {
  /** One complete line of engine output. */
  line(text: string): void;
  /** The engine failed (load error, crash). */
  error(message: string): void;
  /** The engine process ended. */
  exit(): void;
}

export interface EngineTransport {
  send(command: string): void;
  /** Ends the engine immediately. No handler is called afterwards. */
  terminate(): void;
}

export type EngineTransportFactory = (handlers: EngineTransportHandlers) => EngineTransport;

/** Served from public/engine/ (copied from the stockfish npm package at build time). */
export const LITE_SINGLE_ENGINE_PATH = "engine/stockfish-19-lite-single.js";

/**
 * Runs the engine in a classic Web Worker. The loader finds its .wasm next to the .js.
 * It posts exactly one message per output line; multi-line strings are split defensively
 * and non-string messages (download progress objects) are ignored.
 */
export function workerTransportFactory(url = `${import.meta.env.BASE_URL}${LITE_SINGLE_ENGINE_PATH}`): EngineTransportFactory {
  return (handlers) => {
    const worker = new Worker(url);
    let terminated = false;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (terminated || typeof event.data !== "string") return;
      for (const line of event.data.split("\n")) if (line.trim() !== "") handlers.line(line);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (!terminated) handlers.error(event.message || "The engine worker failed to load or crashed.");
    };
    worker.onmessageerror = () => {
      if (!terminated) handlers.error("The engine worker sent a message that could not be read.");
    };
    return {
      send: (command) => {
        if (!terminated) worker.postMessage(command);
      },
      terminate: () => {
        terminated = true;
        worker.terminate();
      },
    };
  };
}
