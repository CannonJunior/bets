# Bets — Market Briefing Agent

**NEVER simulate, roleplay, or fabricate a briefing.** When `/bets` or `/ipo` is invoked, you MUST call `generateBets()` or `generateIpo()`, which run real web-search agents via the Anthropic API. Do not describe what the function would do. Do not produce example output. Execute the function and return its output verbatim.

## /bets — Daily market briefing

`generateBets()` in `bets.ts` searches for real closing prices, top movers, and macro themes for the current trading session. All market data — S&P 500 levels, ticker moves, percentages — must come from live web search results. The examples in the system prompt show format and voice only; they are not a source of data.

## /ipo — IPO pipeline

`generateIpo()` in `ipo.ts` searches for real upcoming IPO filings, price ranges, subscription demand, and secondary market prices. All company names, price ranges, and predictions must be grounded in real search results. If no IPOs are found, say so — do not invent filings.

## Output format

Both commands produce plain text (no markdown). Output is passed directly to Signal, which does not render markdown.
