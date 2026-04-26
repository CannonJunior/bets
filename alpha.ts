/**
 * /alpha — Earnings breakout analyzer.
 *
 * Scores stocks 0–85 on revenue acceleration, gross margin expansion,
 * EPS beat quality, and price momentum. AI web-search layer adds forward
 * guidance context and analyst reactions.
 *
 * Free data sources:
 *   Nasdaq API (no key)          — earnings calendar
 *   Alpha Vantage (free key)     — quarterly financials, EPS history, overview
 *   Anthropic web_search         — guidance language, earnings call highlights
 *
 * Without ALPHA_VANTAGE_API_KEY the command falls back to AI-only analysis.
 *
 * Score labels:  BREAKOUT ≥65 | STRONG ≥45 | WATCH ≥25 | MONITOR <25
 *
 * Exports:
 *   handleAlpha(arg, client, model)  — slash-command handler
 *   runAlphaDaily(client, model)     — cron-job entry point
 */
type PromptRunner = (prompt: string) => Promise<{
  success: boolean;
  timedOut: boolean;
  output: string;
  duration_ms: number;
  exit_code: number | null;
}>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuarterlyReport {
  date: string;        // YYYY-MM-DD fiscal period end
  revenue: number;
  grossProfit: number;
  grossMargin: number; // 0–1
  netIncome: number;
}

interface EpsRecord {
  date: string;
  reportedEps: number;
  estimatedEps: number;
  surprisePct: number; // positive = beat
}

interface StockOverview {
  symbol: string;
  name: string;
  sector: string;
  analystTarget: number;
  change52w: number;   // percentage, e.g. 522.3
}

interface SignalScore {
  total: number;
  label: 'BREAKOUT' | 'STRONG' | 'WATCH' | 'MONITOR';
  lines: string[];     // human-readable signal lines for the report
}

interface EarningsEvent {
  symbol: string;
  name: string;
  reportDate: string;  // YYYY-MM-DD
  epsEstimate?: string;
}

// ---------------------------------------------------------------------------
// Alpha Vantage helpers
// ---------------------------------------------------------------------------

const AV_BASE = 'https://www.alphavantage.co/query';

async function avGet(params: Record<string, string>, avKey: string): Promise<unknown> {
  const url = new URL(AV_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('apikey', avKey);
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'Green/1.0' },
  });
  if (!res.ok) throw new Error(`Alpha Vantage ${params.function} HTTP ${res.status}`);
  return res.json();
}

async function fetchOverview(ticker: string, avKey: string): Promise<StockOverview | null> {
  try {
    const data = await avGet({ function: 'OVERVIEW', symbol: ticker }, avKey) as Record<string, string>;
    if (!data.Symbol) return null;
    return {
      symbol: data.Symbol,
      name: data.Name ?? ticker,
      sector: data.Sector ?? '',
      analystTarget: parseFloat(data.AnalystTargetPrice ?? '0') || 0,
      change52w: parseFloat(data['52WeekChangePercent']?.replace('%', '') ?? '0') || 0,
    };
  } catch {
    return null;
  }
}

async function fetchQuarterlyFinancials(ticker: string, avKey: string): Promise<QuarterlyReport[]> {
  try {
    const data = await avGet({ function: 'INCOME_STATEMENT', symbol: ticker }, avKey) as {
      quarterlyReports?: Record<string, string>[]
    };
    if (!data.quarterlyReports?.length) return [];
    return data.quarterlyReports.map(q => {
      const rev = parseInt(q.totalRevenue ?? '0', 10) || 0;
      const gp  = parseInt(q.grossProfit  ?? '0', 10) || 0;
      const ni  = parseInt(q.netIncome    ?? '0', 10) || 0;
      return {
        date: q.fiscalDateEnding ?? '',
        revenue: rev,
        grossProfit: gp,
        grossMargin: rev > 0 ? gp / rev : 0,
        netIncome: ni,
      };
    }).filter(q => q.date && q.revenue > 0);
  } catch {
    return [];
  }
}

async function fetchEpsHistory(ticker: string, avKey: string): Promise<EpsRecord[]> {
  try {
    const data = await avGet({ function: 'EARNINGS', symbol: ticker }, avKey) as {
      quarterlyEarnings?: Record<string, string>[]
    };
    if (!data.quarterlyEarnings?.length) return [];
    return data.quarterlyEarnings.map(e => ({
      date: e.fiscalDateEnding ?? '',
      reportedEps:  parseFloat(e.reportedEPS  ?? '0') || 0,
      estimatedEps: parseFloat(e.estimatedEPS ?? '0') || 0,
      surprisePct:  parseFloat(e.surprisePercentage ?? '0') || 0,
    })).filter(e => e.date);
  } catch {
    return [];
  }
}

async function fetchAvCalendar(avKey: string, horizon: '3month' | '6month' | '12month' = '3month'): Promise<EarningsEvent[]> {
  try {
    const url = `${AV_BASE}?function=EARNINGS_CALENDAR&horizon=${horizon}&apikey=${avKey}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Green/1.0' } });
    if (!res.ok) return [];
    const csv = await res.text();
    const lines = csv.split('\n').slice(1); // skip header
    const events: EarningsEvent[] = [];
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 3 || !parts[2]?.trim()) continue;
      events.push({
        symbol: parts[0]?.trim() ?? '',
        name: parts[1]?.trim() ?? '',
        reportDate: parts[2].trim(),
        epsEstimate: parts[4]?.trim() || undefined,
      });
    }
    return events.filter(e => e.symbol && e.reportDate);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Nasdaq earnings calendar (no key required)
// ---------------------------------------------------------------------------

async function fetchNasdaqCalendar(date: string): Promise<EarningsEvent[]> {
  try {
    const url = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Green/1.0)',
        'Accept': 'application/json, text/plain, */*',
      },
    });
    if (!res.ok) return [];
    const json = await res.json() as {
      data?: { rows?: { symbol: string; name: string; time?: string; epsForecast?: string }[] }
    };
    return (json.data?.rows ?? []).map(r => ({
      symbol: r.symbol?.trim() ?? '',
      name: r.name?.trim() ?? '',
      reportDate: date,
      epsEstimate: r.epsForecast?.trim() || undefined,
    })).filter(e => e.symbol);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Scoring engine
// ---------------------------------------------------------------------------

function score(quarters: QuarterlyReport[], eps: EpsRecord[], overview: StockOverview | null): SignalScore {
  let total = 0;
  const lines: string[] = [];

  // --- Revenue signals (need at least 8 quarters for true YoY comparison) ---
  if (quarters.length >= 8) {
    // YoY growth rates for last 4 quarters (index 0 = most recent)
    const yoyRates: number[] = [];
    for (let i = 0; i < 4; i++) {
      const curr = quarters[i].revenue;
      const prior = quarters[i + 4].revenue;
      if (prior > 0) yoyRates.push(((curr - prior) / prior) * 100);
    }

    if (yoyRates.length > 0) {
      const latest = yoyRates[0];

      if (latest >= 50) {
        total += 15;
        lines.push(`Revenue growth ${latest.toFixed(0)}% YoY [15 pts]`);
      } else if (latest >= 30) {
        total += 10;
        lines.push(`Revenue growth ${latest.toFixed(0)}% YoY [10 pts]`);
      }

      // Acceleration: each consecutive quarter where YoY rate rose
      let accelQtrs = 0;
      for (let i = 0; i < yoyRates.length - 1; i++) {
        if (yoyRates[i] > yoyRates[i + 1]) accelQtrs++;
        else break;
      }
      if (accelQtrs >= 2) {
        total += 20;
        const trend = yoyRates.slice(0, 4).map(r => `${r.toFixed(0)}%`).reverse().join(' → ');
        lines.push(`Revenue acceleration ${accelQtrs + 1} quarters — ${trend} [20 pts]`);
      } else if (accelQtrs === 1) {
        total += 10;
        lines.push(`Revenue accelerating — ${yoyRates[1].toFixed(0)}% → ${yoyRates[0].toFixed(0)}% YoY [10 pts]`);
      }
    }
  } else if (quarters.length >= 2) {
    // Fewer quarters: score QoQ trend only
    const qoq = quarters.length >= 2
      ? ((quarters[0].revenue - quarters[1].revenue) / quarters[1].revenue) * 100
      : 0;
    if (qoq >= 10) {
      total += 5;
      lines.push(`Revenue QoQ growth ${qoq.toFixed(0)}% [5 pts — limited history]`);
    }
  }

  // --- Gross margin signals ---
  if (quarters.length >= 5) {
    const currGm  = quarters[0].grossMargin * 100;
    const priorGm = quarters[4].grossMargin * 100;
    const delta   = currGm - priorGm;
    if (delta >= 10) {
      total += 20;
      lines.push(`Gross margin ${currGm.toFixed(1)}% (+${delta.toFixed(1)}pp YoY) [20 pts]`);
    } else if (delta >= 3) {
      total += 15;
      lines.push(`Gross margin ${currGm.toFixed(1)}% (+${delta.toFixed(1)}pp YoY) [15 pts]`);
    } else if (delta >= 0) {
      lines.push(`Gross margin stable at ${currGm.toFixed(1)}% [0 pts]`);
    } else {
      lines.push(`Gross margin contracting ${delta.toFixed(1)}pp YoY — watch [0 pts]`);
    }
  } else if (quarters.length >= 1) {
    lines.push(`Gross margin ${(quarters[0].grossMargin * 100).toFixed(1)}% [limited history]`);
  }

  // --- Profitability inflection ---
  if (quarters.length >= 5) {
    const currNi  = quarters[0].netIncome;
    const priorNi = quarters[4].netIncome;
    if (currNi > 0 && priorNi < 0) {
      total += 10;
      lines.push(`Profitability inflection — net income positive after loss period [10 pts]`);
    }
  }

  // --- EPS beat signals ---
  if (eps.length >= 1) {
    const latest = eps[0];
    if (latest.surprisePct >= 10) {
      total += 10;
      lines.push(`EPS beat ${latest.surprisePct.toFixed(1)}% (act $${latest.reportedEps.toFixed(2)} vs est $${latest.estimatedEps.toFixed(2)}) [10 pts]`);
    } else if (latest.surprisePct >= 5) {
      total += 5;
      lines.push(`EPS beat ${latest.surprisePct.toFixed(1)}% [5 pts]`);
    } else if (latest.surprisePct > 0) {
      lines.push(`EPS beat ${latest.surprisePct.toFixed(1)}% [0 pts — marginal]`);
    } else {
      lines.push(`EPS miss ${latest.surprisePct.toFixed(1)}% — caution [0 pts]`);
    }

    const consecutiveBeats = eps.slice(0, 4).filter(e => e.surprisePct > 0).length;
    if (consecutiveBeats >= 3) {
      total += 5;
      lines.push(`${consecutiveBeats} consecutive EPS beats [5 pts]`);
    }
  }

  // --- Price momentum ---
  if (overview?.change52w && overview.change52w >= 100) {
    total += 5;
    lines.push(`52-week return +${overview.change52w.toFixed(0)}% [5 pts]`);
  }

  const capped = Math.min(total, 85);
  let label: SignalScore['label'];
  if (capped >= 65) label = 'BREAKOUT';
  else if (capped >= 45) label = 'STRONG';
  else if (capped >= 25) label = 'WATCH';
  else label = 'MONITOR';

  return { total: capped, label, lines };
}

// ---------------------------------------------------------------------------
// Formatter helpers
// ---------------------------------------------------------------------------

function fmtRevenue(n: number): string {
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6)  return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n}`;
}

function fmtPct(n: number, sign = true): string {
  return `${sign && n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function buildReport(
  ticker: string,
  overview: StockOverview | null,
  quarters: QuarterlyReport[],
  eps: EpsRecord[],
  sig: SignalScore,
  aiContext: string,
): string {
  const name = overview?.name ?? ticker;
  const lines: string[] = [];

  lines.push(`ALPHA — ${name} (${ticker})`);
  lines.push(`Score: ${sig.total}/85 — ${sig.label}`);

  if (overview) {
    const upside = overview.analystTarget > 0
      ? ` | Target: $${overview.analystTarget.toFixed(2)} (${fmtPct(((overview.analystTarget / (eps[0]?.reportedEps ?? 1)) * 100) - 100)} upside)`
      : '';
    lines.push(`52w return: ${fmtPct(overview.change52w)}${upside}`);
    if (overview.sector) lines.push(`Sector: ${overview.sector}`);
  }

  // Quarterly financials
  if (quarters.length > 0) {
    lines.push('');
    lines.push(`FINANCIALS — last ${Math.min(quarters.length, 8)} quarters`);
    const toShow = quarters.slice(0, Math.min(quarters.length, 8));
    for (let i = 0; i < toShow.length; i++) {
      const q = toShow[i];
      let yoyStr = '';
      if (i + 4 < quarters.length) {
        const prior = quarters[i + 4];
        const yoy = prior.revenue > 0 ? ((q.revenue - prior.revenue) / prior.revenue) * 100 : 0;
        const gmDelta = (q.grossMargin - prior.grossMargin) * 100;
        yoyStr = `  YoY: ${fmtPct(yoy)}  GM delta: ${fmtPct(gmDelta)}pp`;
      }
      lines.push(`${q.date}  ${fmtRevenue(q.revenue)}  GM ${(q.grossMargin * 100).toFixed(1)}%${yoyStr}`);
    }
  }

  // EPS history
  if (eps.length > 0) {
    lines.push('');
    lines.push('EPS HISTORY — last 4 quarters');
    for (const e of eps.slice(0, 4)) {
      const beatMiss = e.surprisePct >= 0 ? 'beat' : 'miss';
      lines.push(`${e.date}  Act: $${e.reportedEps.toFixed(2)}  Est: $${e.estimatedEps.toFixed(2)}  ${beatMiss} ${Math.abs(e.surprisePct).toFixed(1)}%`);
    }
  }

  // Signal breakdown
  lines.push('');
  lines.push('SIGNALS');
  if (sig.lines.length > 0) {
    for (const l of sig.lines) lines.push(`  ${l}`);
  } else {
    lines.push('  No significant breakout signals detected.');
  }

  // AI context
  if (aiContext) {
    lines.push('');
    lines.push('CONTEXT');
    for (const l of aiContext.split('\n').filter(Boolean)) lines.push(l);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// AI context via Anthropic web_search
// ---------------------------------------------------------------------------

const ALPHA_SYSTEM = `You are a sharp equity analyst. Summarize recent earnings results concisely.

MANDATORY: Use web_search to get real, current data. NEVER fabricate numbers.

OUTPUT RULES — critical:
- Plain text only. No markdown. No asterisks. No bullet symbols.
- 6-9 lines maximum.
- Each line: one clear declarative sentence.
- Cover: revenue vs estimate, key segment/driver, guidance direction, one analyst reaction, one risk.
- If the company has not yet reported this quarter, state that and give the expected report date.`;

async function fetchAiContext(
  runPrompt: PromptRunner,
  ticker: string,
  name: string,
): Promise<string> {
  const today = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const prompt =
    ALPHA_SYSTEM + '\n\n' +
    `Analyze the most recent earnings report for ${name} (${ticker}) as of ${today}.\n\n` +
    `Search:\n` +
    `1. "${ticker} earnings results Q1 2026"\n` +
    `2. "${ticker} revenue guidance raised lowered"\n` +
    `3. "${ticker} analyst price target upgrade"\n\n` +
    `Report concisely in plain text (6-9 lines):\n` +
    `- Revenue actual vs estimate (% beat/miss)\n` +
    `- Key segment driving results (e.g. HBM, AI cloud, data center)\n` +
    `- Forward guidance — raised, maintained, or lowered (give numbers)\n` +
    `- One analyst reaction or target change\n` +
    `- One key risk or watch item`;

  const result = await runPrompt(prompt);
  if (result.timedOut) {
    const elapsed = (result.duration_ms / 1000).toFixed(0);
    console.error(`[alpha] fetchAiContext timed out for ${ticker} after ${elapsed}s; partial output: ${result.output.length} chars`);
    if (result.output) return result.output.trim() + `\n(context cut short — timed out after ${elapsed}s)`;
    return '';
  }
  return result.output.trim();
}

// ---------------------------------------------------------------------------
// Core per-ticker analysis
// ---------------------------------------------------------------------------

async function analyzeOne(
  ticker: string,
  runPrompt: PromptRunner,
  avKey: string | undefined,
  skipAi: boolean = false,
): Promise<string> {
  const t = ticker.toUpperCase().trim();

  let overview: StockOverview | null = null;
  let quarters: QuarterlyReport[]   = [];
  let eps: EpsRecord[]               = [];

  if (avKey) {
    // Parallel fetch: overview + financials + eps history (3 AV calls per ticker)
    [overview, quarters, eps] = await Promise.all([
      fetchOverview(t, avKey),
      fetchQuarterlyFinancials(t, avKey),
      fetchEpsHistory(t, avKey),
    ]);
  }

  const sig = score(quarters, eps, overview);
  const aiContext = skipAi ? '' : await fetchAiContext(runPrompt, t, overview?.name ?? t);

  return buildReport(t, overview, quarters, eps, sig, aiContext);
}

// ---------------------------------------------------------------------------
// Earnings calendar helpers
// ---------------------------------------------------------------------------

function dateRange(daysBack: number, daysForward: number): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getTime() - daysBack * 86400_000);
  const to   = new Date(now.getTime() + daysForward * 86400_000);
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getTodaysReporters(avKey: string | undefined): Promise<EarningsEvent[]> {
  const today = todayStr();

  // Try Nasdaq API first (no key needed)
  const nasdaqEvents = await fetchNasdaqCalendar(today);
  if (nasdaqEvents.length > 0) return nasdaqEvents;

  // Fallback: Alpha Vantage calendar filtered to today
  if (avKey) {
    const all = await fetchAvCalendar(avKey, '3month');
    return all.filter(e => e.reportDate === today);
  }

  return [];
}

// ---------------------------------------------------------------------------
// /alpha --week calendar formatter
// ---------------------------------------------------------------------------

async function buildWeekCalendar(avKey: string | undefined): Promise<string> {
  const { from, to } = dateRange(0, 7);
  let events: EarningsEvent[] = [];

  if (avKey) {
    const all = await fetchAvCalendar(avKey, '3month');
    events = all.filter(e => e.reportDate >= from && e.reportDate <= to);
  } else {
    // Fetch each day via Nasdaq API
    for (let d = 0; d <= 7; d++) {
      const date = new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
      const day  = await fetchNasdaqCalendar(date);
      events.push(...day);
    }
  }

  if (events.length === 0) {
    return 'No earnings events found for the next 7 days.';
  }

  const lines: string[] = [
    `ALPHA — Earnings Calendar ${from} to ${to}`,
    '',
  ];

  let lastDate = '';
  for (const e of events.slice(0, 50)) {
    if (e.reportDate !== lastDate) {
      lines.push(e.reportDate);
      lastDate = e.reportDate;
    }
    const est = e.epsEstimate ? `  est EPS: ${e.epsEstimate}` : '';
    lines.push(`  ${e.symbol.padEnd(8)} ${e.name}${est}`);
  }

  lines.push('');
  lines.push(`${events.length} companies total. Use /alpha <TICKER> for deep analysis.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Daily cron entry point (no user prompt — proactively sent via Signal)
// ---------------------------------------------------------------------------

export async function runAlphaDaily(
  runPrompt: PromptRunner,
): Promise<string> {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  const today = todayStr();

  const reporters = await getTodaysReporters(avKey);
  if (reporters.length === 0) {
    return `ALPHA — ${today}\nNo earnings reports found today.`;
  }

  const lines: string[] = [
    `ALPHA — ${today}`,
    `${reporters.length} companies reporting today. Analyzing top reporters...`,
    '',
  ];

  // Quick-score all reporters if AV key is available; otherwise take first 5
  const toAnalyze = reporters.slice(0, avKey ? 5 : 3);

  for (const event of toAnalyze) {
    try {
      const report = await analyzeOne(event.symbol, runPrompt, avKey);
      lines.push(report);
      lines.push('---');
    } catch (err) {
      lines.push(`${event.symbol}: analysis failed — ${err instanceof Error ? err.message : String(err)}`);
      lines.push('---');
    }
  }

  if (reporters.length > toAnalyze.length) {
    const rest = reporters.slice(toAnalyze.length).map(e => e.symbol).join(', ');
    lines.push(`Also reporting today: ${rest}`);
    lines.push('Use /alpha <TICKER> for deep analysis on any of these.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Slash-command handler
// ---------------------------------------------------------------------------

export async function handleAlpha(
  arg: string,
  runPrompt: PromptRunner,
): Promise<string> {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  const trimmed = arg.trim();

  // /alpha --week  |  /alpha --calendar  |  /alpha -w
  if (trimmed === '--week' || trimmed === '--calendar' || trimmed === '-w') {
    return buildWeekCalendar(avKey);
  }

  // /alpha <TICKER> [<TICKER2> ...]
  const rawTickers = trimmed
    ? trimmed.toUpperCase().split(/[\s,]+/).filter(Boolean)
    : [];

  if (rawTickers.length > 5) {
    return 'Limit to 5 tickers at a time to stay within free API rate limits.';
  }

  // No tickers supplied → use today's calendar
  if (rawTickers.length === 0) {
    const today = todayStr();
    const reporters = await getTodaysReporters(avKey);

    if (reporters.length === 0) {
      return [
        `ALPHA — ${today}`,
        'No earnings reports found today.',
        '',
        'Usage:',
        '  /alpha <TICKER>     — deep analysis on a specific stock',
        '  /alpha MU ASML      — analyze multiple tickers',
        '  /alpha --week       — earnings calendar for next 7 days',
        '',
        avKey
          ? 'Earnings calendar sourced via Alpha Vantage + Nasdaq API.'
          : 'Tip: add ALPHA_VANTAGE_API_KEY to .env for structured financial scoring.',
      ].join('\n');
    }

    // Analyze first 3 reporters
    const toAnalyze = reporters.slice(0, 3);
    const names = toAnalyze.map(e => e.symbol).join(', ');
    const parts: string[] = [
      `ALPHA — ${today} — Earnings today: ${names}`,
      '',
    ];

    for (const event of toAnalyze) {
      try {
        parts.push(await analyzeOne(event.symbol, runPrompt, avKey));
        parts.push('');
      } catch (err) {
        parts.push(`${event.symbol}: failed — ${err instanceof Error ? err.message : String(err)}`);
        parts.push('');
      }
    }

    if (reporters.length > 3) {
      const rest = reporters.slice(3).map(e => e.symbol).join(', ');
      parts.push(`Also reporting: ${rest}`);
    }

    return parts.join('\n');
  }

  // One or more explicit tickers
  if (!avKey) {
    const parts: string[] = [
      'Note: ALPHA_VANTAGE_API_KEY not set. Falling back to AI-only analysis.',
      '  Get a free key at alphavantage.co and add it to .env.',
      '',
    ];
    for (const t of rawTickers) {
      try {
        parts.push(await analyzeOne(t, runPrompt, undefined));
        parts.push('');
      } catch (err) {
        parts.push(`${t}: failed — ${err instanceof Error ? err.message : String(err)}`);
        parts.push('');
      }
    }
    return parts.join('\n');
  }

  const parts: string[] = [];
  for (const t of rawTickers) {
    try {
      parts.push(await analyzeOne(t, runPrompt, avKey));
      parts.push('');
    } catch (err) {
      parts.push(`${t}: failed — ${err instanceof Error ? err.message : String(err)}`);
      parts.push('');
    }
  }
  return parts.join('\n').trimEnd();
}
