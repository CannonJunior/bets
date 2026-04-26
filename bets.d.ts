/**
 * /bets — Daily market briefing in the voice of a senior fund manager.
 *
 * Style informed by: LPL Research, BlackRock Investment Institute, Howard Marks
 * memos, Seeking Alpha editorial standards, and Morning Brew Markets.
 */
export type PromptRunner = (prompt: string) => Promise<{
    success: boolean;
    timedOut: boolean;
    output: string;
    duration_ms: number;
    exit_code: number | null;
}>;
export declare function generateBets(runPrompt: PromptRunner): Promise<string>;
