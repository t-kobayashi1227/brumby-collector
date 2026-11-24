const MIN_INTERVAL_MS = 3000;
const MAX_RETRIES = 2;
const BLOCK_STATUS_CODES = new Set([403, 429]);
const CAPTCHA_MARKERS = [
  'captcha',
  'px-captcha',
  'are you a human',
  'アクセスが集中',
  '自動的なアクセス',
  '不正なアクセス',
];

let lastRequestAt = 0;

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
}

function looksLikeCaptcha(html: string): boolean {
  const lower = html.toLowerCase();
  return CAPTCHA_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

export function getUserAgent(): string | null {
  const ua = process.env.FETCH_UA;
  if (!ua || ua.trim().length === 0) return null;
  return ua.trim();
}

export const FETCH_UA_EXAMPLE =
  'FETCH_UA="brumby-collector/0.1 (+contact: your-name <you@example.com>)"';

interface RawFetchResult {
  status: number;
  body: string;
}

async function rawGet(url: string, userAgent: string): Promise<RawFetchResult> {
  await throttle();
  lastRequestAt = Date.now();
  const res = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en;q=0.5',
    },
  });
  const body = await res.text();
  return { status: res.status, body };
}

async function getWithRetry(url: string, userAgent: string): Promise<FetchResult> {
  let attempt = 0;
  let lastError: string | null = null;

  while (attempt <= MAX_RETRIES) {
    try {
      const { status, body } = await rawGet(url, userAgent);

      if (BLOCK_STATUS_CODES.has(status)) {
        return { status: 'blocked', httpStatus: status, reason: `HTTP ${status}` };
      }
      if (status >= 500 && status < 600) {
        lastError = `HTTP ${status}`;
        attempt += 1;
        if (attempt <= MAX_RETRIES) continue;
        return { status: 'error', reason: `${lastError}（リトライ上限に到達）` };
      }
      if (status < 200 || status >= 300) {
        return { status: 'error', reason: `HTTP ${status}` };
      }
      if (looksLikeCaptcha(body)) {
        return { status: 'blocked', httpStatus: status, reason: 'CAPTCHA/確認画面を検知' };
      }
      return { status: 'ok', html: body };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        return { status: 'error', reason: `通信エラー（リトライ上限に到達）: ${lastError}` };
      }
    }
  }

  return { status: 'error', reason: lastError ?? '不明な通信エラー' };
}

export type FetchResult =
  | { status: 'ok'; html: string }
  | { status: 'blocked'; httpStatus?: number; reason: string }
  | { status: 'error'; reason: string };

export async function fetchPage(url: string, userAgent: string): Promise<FetchResult> {
  return getWithRetry(url, userAgent);
}

interface RobotsRule {
  pattern: string;
  regex: RegExp;
}

interface RobotsRuleSet {
  disallow: RobotsRule[];
  allow: RobotsRule[];
}

function patternToRegex(pattern: string): RegExp {
  const endsWithDollar = pattern.endsWith('$');
  const body = endsWithDollar ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${endsWithDollar ? '$' : ''}`);
}

interface RobotsGroup {
  agents: string[];
  disallow: string[];
  allow: string[];
}

function parseRobotsTxt(text: string): RobotsRuleSet {
  const lines = text.split(/\r?\n/);
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let seenDirectiveInCurrentGroup = false;

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (key === 'user-agent') {
      if (!current || seenDirectiveInCurrentGroup) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
        seenDirectiveInCurrentGroup = false;
      }
      current.agents.push(value);
    } else if (key === 'disallow' && current) {
      seenDirectiveInCurrentGroup = true;
      if (value) current.disallow.push(value);
    } else if (key === 'allow' && current) {
      seenDirectiveInCurrentGroup = true;
      if (value) current.allow.push(value);
    }
  }

  const disallow: RobotsRule[] = [];
  const allow: RobotsRule[] = [];
  for (const group of groups) {
    if (!group.agents.includes('*')) continue;
    for (const pattern of group.disallow) {
      disallow.push({ pattern, regex: patternToRegex(pattern) });
    }
    for (const pattern of group.allow) {
      allow.push({ pattern, regex: patternToRegex(pattern) });
    }
  }

  return { disallow, allow };
}

function isPathAllowed(path: string, rules: RobotsRuleSet): boolean {
  let bestDisallow = -1;
  for (const rule of rules.disallow) {
    if (rule.regex.test(path) && rule.pattern.length > bestDisallow) {
      bestDisallow = rule.pattern.length;
    }
  }
  if (bestDisallow === -1) return true;

  let bestAllow = -1;
  for (const rule of rules.allow) {
    if (rule.regex.test(path) && rule.pattern.length > bestAllow) {
      bestAllow = rule.pattern.length;
    }
  }
  return bestAllow >= bestDisallow;
}

export type RobotsCheckResult =
  | { allowed: true }
  | { allowed: false; reason: 'unreachable' | 'disallowed'; detail: string };

export async function checkRobotsAllowed(
  baseUrl: string,
  paths: string[],
  userAgent: string
): Promise<RobotsCheckResult> {
  const robotsUrl = new URL('/robots.txt', baseUrl).toString();
  let result: FetchResult;
  try {
    result = await getWithRetry(robotsUrl, userAgent);
  } catch (err) {
    return {
      allowed: false,
      reason: 'unreachable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.status !== 'ok') {
    return {
      allowed: false,
      reason: 'unreachable',
      detail: result.status === 'blocked' ? result.reason : result.reason,
    };
  }

  const rules = parseRobotsTxt(result.html);
  for (const path of paths) {
    if (!isPathAllowed(path, rules)) {
      return { allowed: false, reason: 'disallowed', detail: path };
    }
  }
  return { allowed: true };
}
