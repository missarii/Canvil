/**
 * Path handling and the workspace jail.
 *
 * Canvil only ever touches paths that resolve inside the repository root it was
 * given. Every filesystem tool goes through `resolveInside`; nothing calls
 * `path.resolve` on model-supplied input directly.
 */

import path from "node:path";
import fs from "node:fs";
import { PathSecurityError } from "./errors.js";

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value);
}

/**
 * Resolve `candidate` against `root` and refuse anything that escapes it
 * (absolute paths, `../`, or a symlink whose real target is outside).
 *
 * @param allowRoot when false, the root itself is not a legal target.
 */
export function resolveInside(
  root: string,
  candidate: string,
  options: { allowRoot?: boolean } = {},
): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new PathSecurityError("Empty path is not allowed", candidate);
  }
  if (candidate.includes("\0")) {
    throw new PathSecurityError("NUL byte in path", candidate);
  }

  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const normalized = isAbsolutePath(candidate) ? candidate : path.join(realRoot, candidate);
  const resolved = path.resolve(normalized);

  if (!isInside(realRoot, resolved)) {
    throw new PathSecurityError(
      `Path escapes the workspace root: ${candidate}`,
      candidate,
    );
  }
  if (!options.allowRoot && resolved === realRoot) {
    throw new PathSecurityError("Target is the workspace root, not a file", candidate);
  }

  // Follow symlinks for the nearest existing ancestor so a link inside the repo
  // cannot be used to write outside it.
  const existingAncestor = nearestExistingAncestor(resolved);
  if (existingAncestor) {
    const realAncestor = fs.realpathSync(existingAncestor);
    if (!isInside(realRoot, realAncestor)) {
      throw new PathSecurityError(
        `Path resolves through a symlink outside the workspace: ${candidate}`,
        candidate,
      );
    }
  }

  return resolved;
}

/** True when `target` is `root` or lives beneath it. Uses a separator-aware
 *  comparison so `/repo-other` is not treated as inside `/repo`. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Repository-relative, POSIX-separated path used as a stable identifier. */
export function relativeToRoot(root: string, absolute: string): string {
  return toPosix(path.relative(path.resolve(root), path.resolve(absolute)));
}

function nearestExistingAncestor(target: string): string | null {
  let current = target;
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Convert a glob (supporting `*`, `**`, `?` and `{a,b}` alternation) to a
 * RegExp anchored to a POSIX path.
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = toPosix(glob);
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` may match zero directories: `a/**/b` matches `a/b`.
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close !== -1) {
        const alternatives = pattern
          .slice(i + 1, close)
          .split(",")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${alternatives.join("|")})`;
        i = close;
        continue;
      }
    }
    out += char ? char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  }
  return new RegExp(`^${out}$`);
}

/** Test a repo-relative POSIX path against a list of globs. */
export function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
  const target = toPosix(relativePath);
  return globs.some((glob) => globToRegExp(glob).test(target));
}

/** Heuristic binary check on a buffer (NUL byte in the first 4 KiB). */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  return sample.includes(0);
}
