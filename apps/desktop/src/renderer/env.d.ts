import type { MuninBridge } from "../shared/ipc.js";

declare global {
  interface Window {
    /** Injected by the preload bridge; absent if preload failed to load. */
    readonly munin?: MuninBridge;
  }
}

export {};
