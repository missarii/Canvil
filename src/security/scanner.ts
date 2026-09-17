/**
 * Security review.
 *
 * A deterministic, rule-based pass over the changed files. It runs *before* the
 * model-based review because it is cheap, reproducible and cannot be talked out
 * of a finding — the model is then asked to reason about anything the rules
 * flagged, rather than being trusted to notice them itself.
 *
 * Rules are mapped to OWASP Top 10:2025 categories and CWE ids so the report
 * says *why* something is a problem, not just that a pattern matched.
 */

import fs from "node:fs";
import path from "node:path";
import { toPosix } from "../util/paths.js";
import { truncate } from "../util/text.js";

export type Severity = "high" | "medium" | "low";

export interface SecurityFinding {
  ruleId: string;
  title: string;
  severity: Severity;
  file: string;
  line: number;
  excerpt: string;
  /** OWASP Top 10:2025 category. */
  owasp: string;
  cwe: string;
  recommendation: string;
}

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  owasp: string;
  cwe: string;
  recommendation: string;
  pattern: RegExp;
  /** Set false for rules that must also inspect comments (e.g. leaked keys). */
  skipComments?: boolean;
}

const COMMENT_PATTERNS = [/^\s*\/\//, /^\s*#/, /^\s*\*/, /^\s*\/\*/, /^\s*<!--/];

export const SECURITY_RULES: Rule[] = [
  {
    id: "hardcoded-credential",
    title: "Hardcoded credential",
    severity: "high",
    owasp: "A02:2025 Security Misconfiguration",
    cwe: "CWE-798",
    recommendation:
      "Move the value into an environment variable and rotate the exposed credential, since it is already in version control.",
    pattern:
      /(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
    skipComments: false,
  },
  {
    id: "secret-assignment",
    title: "Secret assigned a literal value",
    severity: "high",
    owasp: "A02:2025 Security Misconfiguration",
    cwe: "CWE-798",
    recommendation: "Read the value from configuration or secret storage; never inline it in source.",
    pattern:
      /(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i,
    skipComments: true,
  },
  {
    id: "eval-usage",
    title: "Dynamic code evaluation",
    severity: "high",
    owasp: "A03:2025 Injection",
    cwe: "CWE-95",
    recommendation:
      "Remove eval/new Function. Parse data with JSON.parse or a schema validator, or dispatch on an allowlist of known operations.",
    pattern: /\b(eval|new\s+Function)\s*\(/,
    skipComments: true,
  },
  {
    id: "command-injection",
    title: "Shell command built from a variable",
    severity: "high",
    owasp: "A03:2025 Injection",
    cwe: "CWE-78",
    recommendation:
      "Use execFile/spawn with an argument array so the shell never parses user input. Never interpolate values into a command string.",
    pattern: /(?:exec|execSync|spawnSync)[\s\S]{0,80}?`[^`]*\$\{|(?:exec|execSync)\(\s*["'][^"']*["']\s*\+/,
    skipComments: true,
  },
  {
    id: "sql-string-concatenation",
    title: "SQL built by string interpolation",
    severity: "high",
    owasp: "A03:2025 Injection",
    cwe: "CWE-89",
    recommendation:
      "Use parameterised queries: pass values as bind parameters instead of concatenating or interpolating them into SQL.",
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|WHERE)[^;'"`]{0,80}(?:\$\{|\+\s*\w+\s*\+|["']\s*\+)/i,
    skipComments: true,
  },
  {
    id: "raw-html-sink",
    title: "Unescaped HTML sink",
    severity: "high",
    owasp: "A03:2025 Injection",
    cwe: "CWE-79",
    recommendation:
      "Render text through the framework's escaping. If HTML is genuinely required, sanitise it with a maintained library and an allowlist.",
    pattern: /(?:innerHTML\s*=|dangerouslySetInnerHTML|v-html=|document\.write\s*\()/,
    skipComments: true,
  },
  {
    id: "mass-assignment",
    title: "Mass assignment from request data",
    severity: "medium",
    owasp: "A01:2025 Broken Access Control",
    cwe: "CWE-915",
    recommendation:
      "Pick fields explicitly (or validate with a strict schema that rejects unknown keys) so clients cannot set privileged fields such as role or owner.",
    pattern: /(?:Object\.assign\(\s*\w+\s*,\s*(?:req|request)\.body|\.\.\.\s*(?:req|request)\.body)/,
    skipComments: true,
  },
  {
    id: "jwt-without-verification",
    title: "JWT without signature verification",
    severity: "high",
    owasp: "A07:2025 Authentication Failures",
    cwe: "CWE-347",
    recommendation:
      "Always verify the signature and the iss/aud/exp claims. jwt.decode only base64-decodes the token and trusts attacker-controlled data.",
    pattern: /\b(?:jwt|jsonwebtoken)\.decode\s*\(|verify\s*:\s*false/,
    skipComments: true,
  },
  {
    id: "weak-password-hash",
    title: "Weak password hashing",
    severity: "high",
    owasp: "A07:2025 Authentication Failures",
    cwe: "CWE-916",
    recommendation:
      "Use argon2id, or bcrypt with cost >= 12, for passwords. MD5 and SHA-1 are not password hashes.",
    pattern: /(?:createHash\(\s*["'](?:md5|sha1)["']\)|hashlib\.(?:md5|sha1)\s*\()/i,
    skipComments: true,
  },
  {
    id: "insecure-random-token",
    title: "Non-cryptographic randomness for a security value",
    severity: "medium",
    owasp: "A07:2025 Authentication Failures",
    cwe: "CWE-338",
    recommendation:
      "Use crypto.randomBytes / crypto.getRandomValues (or secrets.token_urlsafe in Python) for tokens, ids and nonces.",
    pattern: /(?:Math\.random\(\)[\s\S]{0,40}(?:token|secret|session|nonce|id)|random\.random\(\))/i,
    skipComments: true,
  },
  {
    id: "tls-verification-disabled",
    title: "TLS verification disabled",
    severity: "high",
    owasp: "A02:2025 Security Misconfiguration",
    cwe: "CWE-295",
    recommendation:
      "Never disable certificate validation, not even temporarily. Fix the trust store or pin the correct CA bundle instead.",
    pattern:
      /(?:rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|verify\s*=\s*False)/,
    skipComments: true,
  },
  {
    id: "permissive-cors",
    title: "Permissive CORS with credentials",
    severity: "medium",
    owasp: "A02:2025 Security Misconfiguration",
    cwe: "CWE-942",
    recommendation:
      "Use an explicit origin allowlist. A wildcard origin combined with credentials lets any site read authenticated responses.",
    pattern:
      /(?:origin\s*:\s*["']\*["'][\s\S]{0,40}credentials\s*:\s*true|Access-Control-Allow-Origin["']?\s*,\s*["']\*)/,
    skipComments: true,
  },
  {
    id: "stack-trace-leak",
    title: "Internal error detail returned to the client",
    severity: "medium",
    owasp: "A02:2025 Security Misconfiguration",
    cwe: "CWE-209",
    recommendation:
      "Log the detail server-side and return an opaque message plus a correlation id to the caller.",
    pattern: /(?:res(?:ponse)?\.(?:send|json|write)\([^)]*\.stack|return\s+str\(e\))/,
    skipComments: true,
  },
  {
    id: "path-traversal",
    title: "File path built from request data",
    severity: "high",
    owasp: "A01:2025 Broken Access Control",
    cwe: "CWE-22",
    recommendation:
      "Resolve the path, then verify it stays inside the intended base directory, or map an opaque id to a known file.",
    pattern: /(?:path\.join|path\.resolve|os\.path\.join)\s*\([^)]*(?:req\.|request\.|params|query)/,
    skipComments: true,
  },
  {
    id: "weak-bcrypt-cost",
    title: "Low bcrypt cost factor",
    severity: "low",
    owasp: "A07:2025 Authentication Failures",
    cwe: "CWE-916",
    recommendation: "Use a cost factor of at least 12, and re-measure it on your hardware.",
    pattern: /bcrypt\.(?:hash|hashSync|genSalt)[\s\S]{0,60}?,\s*(?:[1-9]|10)\b/,
    skipComments: true,
  },
  {
    id: "http-endpoint",
    title: "Plain HTTP endpoint",
    severity: "low",
    owasp: "A02:2025 Security Misconfiguration",
    cwe: "CWE-319",
    recommendation:
      "Use HTTPS for service endpoints; plain HTTP exposes tokens and payloads to anyone on the path.",
    pattern: /["']http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[a-z0-9.-]+/,
    skipComments: true,
  },
];

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export interface ScanOptions {
  repoRoot: string;
  /** Repository-relative files to scan; typically the changed files. */
  files: readonly string[];
  maxFileBytes?: number;
  /** Cap findings per rule so one repetitive mistake cannot flood the report. */
  maxPerRule?: number;
}

export interface SecurityReport {
  findings: SecurityFinding[];
  scannedFiles: string[];
  skippedFiles: string[];
  rulesEvaluated: number;
}

/** Run every rule over the given files. */
export function scanFilesForSecurity(options: ScanOptions): SecurityReport {
  const maxFileBytes = options.maxFileBytes ?? 400_000;
  const maxPerRule = options.maxPerRule ?? 10;
  const findings: SecurityFinding[] = [];
  const scannedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const perRuleCount = new Map<string, number>();

  for (const file of options.files) {
    const absolutePath = path.resolve(options.repoRoot, file);
    const relative = toPosix(file);
    let contents: string;
    try {
      const stats = fs.statSync(absolutePath);
      if (!stats.isFile() || stats.size > maxFileBytes) {
        skippedFiles.push(relative);
        continue;
      }
      contents = fs.readFileSync(absolutePath, "utf8");
    } catch {
      skippedFiles.push(relative);
      continue;
    }

    scannedFiles.push(relative);
    const lines = contents.split("\n");

    for (const rule of SECURITY_RULES) {
      if ((perRuleCount.get(rule.id) ?? 0) >= maxPerRule) continue;

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (rule.skipComments !== false && COMMENT_PATTERNS.some((pattern) => pattern.test(line))) {
          continue;
        }
        if (!rule.pattern.test(line)) continue;

        findings.push({
          ruleId: rule.id,
          title: rule.title,
          severity: rule.severity,
          file: relative,
          line: index + 1,
          excerpt: truncate(line.trim(), 200, "…"),
          owasp: rule.owasp,
          cwe: rule.cwe,
          recommendation: rule.recommendation,
        });
        perRuleCount.set(rule.id, (perRuleCount.get(rule.id) ?? 0) + 1);
        if ((perRuleCount.get(rule.id) ?? 0) >= maxPerRule) break;
      }
    }
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  return { findings, scannedFiles, skippedFiles, rulesEvaluated: SECURITY_RULES.length };
}

export interface SecuritySummary {
  total: number;
  high: number;
  medium: number;
  low: number;
  /** True when nothing at high or medium severity was found. */
  acceptable: boolean;
  byRule: Array<{ ruleId: string; title: string; severity: Severity; count: number }>;
}

export function summarizeSecurityReport(report: SecurityReport): SecuritySummary {
  const counts = { high: 0, medium: 0, low: 0 };
  const byRule = new Map<
    string,
    { ruleId: string; title: string; severity: Severity; count: number }
  >();

  for (const finding of report.findings) {
    counts[finding.severity] += 1;
    const existing = byRule.get(finding.ruleId);
    if (existing) {
      existing.count += 1;
    } else {
      byRule.set(finding.ruleId, {
        ruleId: finding.ruleId,
        title: finding.title,
        severity: finding.severity,
        count: 1,
      });
    }
  }

  return {
    total: report.findings.length,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    acceptable: counts.high === 0 && counts.medium === 0,
    byRule: [...byRule.values()].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count,
    ),
  };
}

/** Rule catalogue without the regexes, for documentation and tests. */
export function securityRuleCatalogue(): Array<Omit<Rule, "pattern">> {
  return SECURITY_RULES.map(({ pattern: _pattern, ...rest }) => rest);
}