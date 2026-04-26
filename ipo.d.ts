/**
 * /ipo — Upcoming IPO calendar with day-1 open and close price predictions.
 *
 * Prediction methodology grounded in academic literature and practitioner data:
 *   - Subscription demand is the #1 predictor (55% of ML model importance)
 *   - Price revision from initial to final range is a strong secondary signal
 *   - Comparable company multiples set the valuation anchor
 *   - Sector momentum determines the sentiment premium
 *   - Underwriter tier correlates with pricing accuracy
 *
 * Benchmarks embedded in prompt:
 *   - 2025 median first-day pop: 13% | average: 22%
 *   - 2024 average first-day pop: 31%
 *   - 3-5x oversubscribed → expect 20-30% pop
 *   - 10x+ oversubscribed → expect 40%+ pop
 *   - Priced below range → flat or negative day 1
 */
export type PromptRunner = (prompt: string) => Promise<{
    success: boolean;
    timedOut: boolean;
    output: string;
    duration_ms: number;
    exit_code: number | null;
}>;
export declare function generateIpo(runPrompt: PromptRunner, date?: string, symbols?: string[]): Promise<string>;
export declare function generateIpoSymbols(runPrompt: PromptRunner): Promise<string>;
