/**
 * Bounded HTTP fetching.
 *
 * Every outbound request in Canvil goes through here so that timeouts, size
 * caps and user-agent policy are applied in exactly one place. Research tools
 * must never be able to hang a run or pull a 200 MB page into memory.
 */

import { ExternalServiceError } from "./errors.js";

export interface FetchTextOptions {
  timeoutMs: number;
  /** Hard cap on downloaded bytes; the stream is abandoned past this point. */
  maxBytes: number;
  headers?: Record<string, string>;
  userAgent?: string;
  method?: "GET" | "POST" | "PUT";
  body?: string;
  /** Restrict to these content types (prefix match). */
  accept?: string[];
}

export interface FetchTextResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  bytes: number;
}

export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

const REDIRECT_LIMIT = 5;

/**
 * Fetch a URL as text with a timeout and a byte cap.
 *
 * Redirects are followed manually so that (a) the hop count is bounded and
 * (b) the final URL is reported — citations must point at the page that was
 * actually read, not at a redirector.
 */
export async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  options: FetchTextOptions,
): Promise<FetchTextResult> {
  let currentUrl = url;
  let response: Response | null = null;

  for (let hop = 0; hop <= REDIRECT_LIMIT; hop += 1) {
    try {
      response = await fetchImpl(currentUrl, {
        method: options.method ?? "GET",
        redirect: "manual",
        headers: {
          accept: options.accept?.join(", ") ?? "text/html,application/json,text/plain;q=0.9,*/*;q=0.5",
          "user-agent": options.userAgent ?? "Canvil/0.1",
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.headers ?? {}),
        },
        ...(options.body ? { body: options.body } : {}),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      throw new ExternalServiceError(
        `Request to ${currentUrl} failed: ${(error as Error).message}`,
        hostOf(currentUrl),
        { cause: error },
      );
    }

    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }

  if (!response) {
    throw new ExternalServiceError(`No response from ${url}`, hostOf(url));
  }

  const contentType = response.headers.get("content-type") ?? "";
  const { text, truncated, bytes } = await readBounded(response, options.maxBytes);

  return {
    url,
    finalUrl: currentUrl,
    status: response.status,
    contentType,
    body: text,
    truncated,
    bytes,
  };
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; bytes: number }> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    const buffer = Buffer.from(text, "utf8");
    if (buffer.length <= maxBytes) return { text, truncated: false, bytes: buffer.length };
    return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true, bytes: maxBytes };
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      const remaining = maxBytes - bytes;
      if (chunk.length >= remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cancelling a finished stream is not an error worth surfacing.
    }
  }

  return { text: Buffer.concat(chunks).toString("utf8"), truncated, bytes };
}

/** Parse a JSON response body, turning malformed payloads into a clear error. */
export function parseJsonBody<T>(result: FetchTextResult, service: string): T {
  if (!isSuccessStatus(result.status)) {
    throw new ExternalServiceError(
      `${service} returned HTTP ${result.status}: ${result.body.slice(0, 300)}`,
      service,
    );
  }
  try {
    return JSON.parse(result.body) as T;
  } catch (error) {
    throw new ExternalServiceError(
      `${service} returned invalid JSON (content-type: ${result.contentType || "unknown"})`,
      service,
      { cause: error },
    );
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}