import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import type { EngineTransportFactory } from "@/infra/engine/transport";

/**
 * TEST HELPER (not production code). Runs the pinned npm Stockfish build
 * (lite single-threaded WASM) as a Node child process speaking UCI over stdio,
 * so @engine tests can stop it, time it out and kill it for real (decision D11).
 */
const require = createRequire(import.meta.url);
export const ENGINE_PATH: string = (require("stockfish") as { findEngine(type: string): string }).findEngine("lite-single");

export interface NodeEngineFleet {
  factory: EngineTransportFactory;
  children: ChildProcessWithoutNullStreams[];
  /** Simulates a crash: kills a child without going through terminate(). */
  kill(index: number): void;
}

export function nodeEngineFleet(options: { onCommand?: (command: string, index: number, fleet: NodeEngineFleet) => void } = {}): NodeEngineFleet {
  const fleet: NodeEngineFleet = {
    children: [],
    kill: (index) => {
      fleet.children[index]?.kill("SIGKILL");
    },
    factory: (handlers) => {
      const index = fleet.children.length;
      const child = spawn(process.execPath, [ENGINE_PATH], { stdio: ["pipe", "pipe", "pipe"] });
      fleet.children.push(child);
      let terminated = false;
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (!terminated) handlers.line(line);
      });
      child.on("error", (error) => {
        if (!terminated) handlers.error(error.message);
      });
      child.on("exit", () => {
        if (!terminated) handlers.exit();
      });
      child.stdin.on("error", () => undefined); // writes after a kill are expected in crash tests
      return {
        send: (command) => {
          if (terminated) return;
          options.onCommand?.(command, index, fleet);
          child.stdin.write(`${command}\n`);
        },
        terminate: () => {
          terminated = true;
          child.kill();
        },
      };
    },
  };
  return fleet;
}
