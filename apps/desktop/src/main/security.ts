/**
 * Navigation and sender trust.
 *
 * The renderer may only load the built index.html or the configured Vite dev
 * origin. Every other URL, scheme or host is refused, including IPC invocations
 * from frames that somehow reached another origin.
 */
import { pathToFileURL } from "node:url";

export interface TrustOptions {
  /** Vite dev server origin, when running `electron .` against it. */
  devUrl?: string;
  /** Absolute directory containing the built renderer. */
  rendererDir: string;
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export function isTrustedRendererUrl(rawUrl: string, options: TrustOptions): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (options.devUrl !== undefined) {
    let dev: URL;
    try {
      dev = new URL(options.devUrl);
    } catch {
      return false;
    }
    if (url.protocol === dev.protocol && url.host === dev.host) return true;
  }

  if (url.protocol !== "file:") return false;
  return url.href.startsWith(withTrailingSlash(pathToFileURL(options.rendererDir).href));
}
