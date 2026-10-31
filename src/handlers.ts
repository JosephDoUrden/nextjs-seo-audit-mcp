import {
  ISSUE_CODES,
  ISSUE_DESCRIPTIONS,
  MODULE_IDS,
  VERSION,
  buildAgentReport,
  describeCode,
  diffReports,
  getExitCode,
  runAudit,
} from 'vercel-seo-audit';
import type {
  AgentFinding,
  AgentReport,
  AuditFinding,
  AuditReport,
  IssueCode,
  ModuleId,
  RunAuditOptions,
} from 'vercel-seo-audit';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { checkTarget } from './guard.js';
import {
  MAX_TEXT_CHARS,
  MAX_URL_CHARS,
  UNTRUSTED_NOTICE,
  capDetails,
  capFinding,
  cleanDeep,
  cleanString,
} from './sanitise.js';
import { LIMITS, type PreviousReport, type USER_AGENTS } from './tools.js';

// Copied from USER_AGENT_PRESETS in vercel-seo-audit's src/constants.ts (2.17.0), which the
// package does not export. `default` sends nothing, so the audit uses its own UA.
const USER_AGENT_STRINGS: Record<(typeof USER_AGENTS)[number], string | undefined> = {
  default: undefined,
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
};

// vercel-seo-audit 2.19.0 added `maxHtmlBytes` to RunAuditOptions; the alias stays so the
// call site below reads the same as before.
type AuditOptions = RunAuditOptions;

export interface AuditSiteArgs {
  url: string;
  only?: ModuleId[];
  crawl?: number;
  userAgent?: (typeof USER_AGENTS)[number];
  timeout?: number;
  ignore?: IssueCode[];
  previous?: PreviousReport;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function structured(value: Record<string, unknown>, notice?: string): CallToolResult {
  const json = JSON.stringify(value);
  return {
    content: [{ type: 'text', text: notice ? `${notice}\n${json}` : json }],
    structuredContent: value,
  };
}

/** A URL as both sides of the diff key it: cleaned the way the output is, and capped. */
const diffUrl = (url: string) => cleanString(url, MAX_URL_CHARS);

/**
 * Turns an earlier AgentReport back into the AuditReport shape diffReports reads. Findings
 * are matched by `code::url`, so only those fields have to be right; the modules the earlier
 * run skipped become its `only`, so a module only one run had is neither new nor resolved.
 * Every string is cleaned and capped like the output, since the caller sent it.
 */
export function previousToAuditReport(prev: PreviousReport): AuditReport {
  const byModule = new Map<string, AuditFinding[]>();
  for (const f of prev.findings) {
    const finding: AuditFinding = {
      code: f.code,
      severity: f.severity,
      category: cleanString(f.category, MAX_TEXT_CHARS) as AuditFinding['category'],
      message: cleanString(f.message, MAX_TEXT_CHARS),
      explanation: '',
      suggestion: f.fix === null ? '' : cleanString(f.fix, MAX_TEXT_CHARS),
      ...(f.details && { details: capDetails(f.details) as Record<string, unknown> }),
      ...(f.url !== null && { url: diffUrl(f.url) }),
    };
    const module = cleanString(f.module, MAX_TEXT_CHARS);
    const list = byModule.get(module) ?? [];
    list.push(finding);
    byModule.set(module, list);
  }
  const skipped = new Set<string>(prev.skipped);
  return {
    url: diffUrl(prev.url),
    timestamp: new Date(0).toISOString(),
    duration: 0,
    summary: { errors: prev.summary.errors, warnings: prev.summary.warnings, info: prev.summary.info, passed: 0 },
    modules: [...byModule].map(([module, findings]) => ({ module, findings })),
    ...(skipped.size > 0 && { only: MODULE_IDS.filter((id) => !skipped.has(id)) }),
  };
}

/**
 * The current report as diffReports should see it. `only` is set to the modules that ran,
 * because a full run without `crawl` has no `only` and would otherwise count every crawl
 * finding in `previous` as resolved. URLs are cleaned like `previous`'s were, so a URL with
 * a stripped character is not both new and resolved.
 */
export function currentForDiff(report: AuditReport): AuditReport {
  const ran = report.modules.map((m) => m.module).filter((m): m is ModuleId => m !== 'target');
  return {
    ...report,
    modules: report.modules.map((m) => ({
      ...m,
      findings: m.findings.map((f) => (f.url === undefined ? f : { ...f, url: diffUrl(f.url) })),
    })),
    only: ran,
  };
}

// buildAgentReport already caps message and fix at 500 characters and strips some control
// and bidi characters (vercel-seo-audit 2.17.0). This second pass is defence in depth, so a
// regression there, or a field or character it does not cover, still does not reach the model.
function cleanReport(report: AgentReport): AgentReport {
  const cleaned = cleanDeep(report) as AgentReport;
  const capAll = (list: AgentFinding[]) => list.map(capFinding);
  return {
    ...cleaned,
    url: cleanString(cleaned.url, MAX_URL_CHARS),
    finalUrl: cleaned.finalUrl === null ? null : cleanString(cleaned.finalUrl, MAX_URL_CHARS),
    findings: capAll(cleaned.findings),
    ...(cleaned.diff && {
      diff: { ...cleaned.diff, new: capAll(cleaned.diff.new), resolved: capAll(cleaned.diff.resolved) },
    }),
  };
}

/** Settles with `promise`, or rejects with the signal's reason as soon as it fires. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

let inFlight = false;

/** True while an audit_site call holds the one slot. */
export function auditRunning(): boolean {
  return inFlight;
}

export async function auditSite(args: AuditSiteArgs, opts: { signal?: AbortSignal } = {}): Promise<CallToolResult> {
  if (inFlight) return toolError('audit already running: one audit_site call at a time, try again when it finishes');
  inFlight = true;
  try {
    if (args.url.length > LIMITS.urlMaxChars) return toolError(`url is longer than ${LIMITS.urlMaxChars} characters`);

    const crawl = args.crawl === undefined ? undefined : clamp(args.crawl, LIMITS.crawlMin, LIMITS.crawlMax);
    const timeout = clamp(args.timeout ?? LIMITS.timeoutDefaultMs, LIMITS.timeoutMinMs, LIMITS.timeoutMaxMs);
    const wallClockMs = LIMITS.wallClockBaseMs + LIMITS.wallClockPerPageMs * (crawl ?? 0);
    // Made before the DNS pre-check, so a resolver that hangs is inside the same cap.
    const signals = [AbortSignal.timeout(wallClockMs), ...(opts.signal ? [opts.signal] : [])];
    const signal = AbortSignal.any(signals);

    const auditOptions: AuditOptions = {
      timeout,
      crawl,
      userAgent: args.userAgent ? USER_AGENT_STRINGS[args.userAgent] : undefined,
      only: args.only,
      ignore: args.ignore,
      // Since vercel-seo-audit 2.17.0 this aborts every request in flight and runAudit
      // rejects with an AbortError, so the slot below is free again straight away.
      signal,
      maxHtmlBytes: LIMITS.maxHtmlBytes,
    };

    let report: AuditReport;
    try {
      // A lookup left running after an abort finishes on its own; its answer is dropped.
      const target = await abortable(checkTarget(args.url), signal);
      if (!target.ok) return toolError(`refused: ${target.reason}`);
      report = await runAudit(target.url.href, auditOptions);
    } catch (err) {
      if (!signal.aborted) throw err;
      if (opts.signal?.aborted) return toolError('audit cancelled');
      return toolError(`audit timed out after ${wallClockMs / 1000} s`);
    }

    const reached = !report.modules.some((m) => m.findings.some((f) => f.code === 'TARGET_UNREACHABLE'));
    const exitCode = getExitCode(report.summary, false, reached);
    let agent: AgentReport;
    if (args.previous) {
      const previous = previousToAuditReport(args.previous);
      const current = currentForDiff(report);
      agent = buildAgentReport(current, {
        version: VERSION,
        exitCode,
        diff: { result: diffReports(current, previous), previous },
      });
    } else {
      agent = buildAgentReport(report, { version: VERSION, exitCode });
    }
    return structured(cleanReport(agent) as unknown as Record<string, unknown>, UNTRUSTED_NOTICE);
  } catch (err) {
    // Error text can quote the site (a header, a URL), so it is cleaned like a finding.
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`audit failed: ${cleanString(message, MAX_TEXT_CHARS)}`);
  } finally {
    inFlight = false;
  }
}

/** Levenshtein distance, for suggesting codes. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** The three known codes nearest `input`; ties keep ISSUE_CODES order. */
export function closestCodes(input: string, count = 3): IssueCode[] {
  return ISSUE_CODES.map((code, index) => ({ code, index, d: distance(input, code) }))
    .sort((x, y) => x.d - y.d || x.index - y.index)
    .slice(0, count)
    .map((x) => x.code);
}

export function explainFinding(args: { code: string }): CallToolResult {
  const normalised = args.code.trim().toUpperCase().replace(/-/g, '_');
  if (!(ISSUE_CODES as readonly string[]).includes(normalised)) {
    const shown = JSON.stringify(cleanDeep(args.code.slice(0, 64)));
    return toolError(`unknown code ${shown}; closest: ${closestCodes(normalised).join(', ')}`);
  }
  const entry = describeCode(normalised as IssueCode);
  return structured({ ...entry });
}

const SOURCES = ['target', ...MODULE_IDS] as const;

export function listChecks(): CallToolResult {
  const entries = ISSUE_CODES.map(describeCode);
  const modules = SOURCES.map((id) => ({
    id,
    codes: entries
      .filter((e) => (e.modules as readonly string[]).includes(id))
      .map((e) => ({ code: e.code, description: ISSUE_DESCRIPTIONS[e.code] })),
  })).filter((m) => m.codes.length > 0);
  return structured({ version: VERSION, modules });
}
