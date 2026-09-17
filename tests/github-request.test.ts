import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { githubRequest } from "../src/tools/github/index.js";
import { noopExecutor, type ToolContext } from "../src/tools/types.js";
import { silentLogger } from "../src/util/logger.js";

describe("GitHub HTTP requests", () => {
  it.each(["GET", "POST", "PUT"] as const)("forwards %s and parses JSON", async (method) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const context: ToolContext = {
      repoRoot: process.cwd(), config: DEFAULT_CONFIG, env: {},
      logger: silentLogger, fetchImpl, executor: noopExecutor,
    };
    const body = method === "GET" ? undefined : { message: "Documentation" };
    const result = await githubRequest<{ id: number }>({
      context, path: "/repos/example/project", method, body,
    });
    expect(result.data).toEqual({ id: 42 });
    expect(result.authenticated).toBe(false);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "https://api.github.com/repos/example/project",
      expect.objectContaining({ method }),
    );
    const options = fetchImpl.mock.calls[0]![1]!;
    expect(options.body).toBe(body ? JSON.stringify(body) : undefined);
    if (body) expect(new Headers(options.headers).get("content-type")).toBe("application/json");
  });

  it("defaults to GET and reports HTTP failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("Not found", { status: 404 }));
    const context: ToolContext = {
      repoRoot: process.cwd(), config: DEFAULT_CONFIG, env: {},
      logger: silentLogger, fetchImpl, executor: noopExecutor,
    };
    await expect(githubRequest({ context, path: "/repos/example/missing" })).rejects.toThrow("HTTP 404");
    expect(fetchImpl.mock.calls[0]![1]!.method).toBe("GET");
  });
});
