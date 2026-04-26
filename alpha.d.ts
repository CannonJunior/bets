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
export declare function runAlphaDaily(runPrompt: PromptRunner): Promise<string>;
export declare function handleAlpha(arg: string, runPrompt: PromptRunner): Promise<string>;
export {};
