# Munin pricing

Where the numbers in `@munin/core`'s pricing registry come from, how they are
applied, and how to update one. The authority is a dated rate-card snapshot in
`packages/core/src/pricing/`; the source never invents a price.

## Provenance

- **Observed cost** comes from the source only. If OpenCode recorded a charge,
  it is the headline and Munin's estimate is a cross-check.
- **List prices** are transcribed cards in `pricing/catalogue/` (anthropic,
  google, openai, ollama, open). Each card carries `from` (the date it took
  effect) and a `label` naming the provenance, e.g.
  `"Ollama Cloud list price, checked 2026-10-22"`.
- `PRICING_AS_OF` (`2026-10-22`) and `PRICING_VERSION` (1), in
  `pricing/providers.ts`, name the snapshot the whole checkout of cards
  belongs to. Bump `PRICING_VERSION` when cards change meaningfully; the
  report exposes both so any dollar figure can be pinned to a catalogue state.
- Dated rate changes use multiple entries in `rates: [{ from, ... }]`;
  `cardFor(price, { at })` picks the newest card whose `from` is not after the
  call's timestamp. A call is always priced on its own date's card.

## Units

All rates are **US dollars per million tokens** (`PerM` suffix everywhere).
Peak-hours discounts (e.g. DeepSeek off-peak factor) apply by the call's UTC
timestamp. Provider cache policy (in `providers.ts`) derives the billed rates:

| Policy field              | Effect                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| `read`                    | Multiplier on input for a cached-read token.                           |
| `write5m`/`write1h`       | Multiplier on input for cache-write tokens per TTL.                    |
| `batch`                   | Multiplier for batch traffic.                                          |
| `inputIncludesCacheReads` | Source reports input inclusive of cached reads; the builder subtracts. |

A card's **explicit** cached rate (e.g. `gpt-oss:120b`'s $0.014/M) overrides
the multiplier, because some providers publish the exact per-token rate
instead. `ratesFor()` returns the resolved set: `inputPerM`, `outputPerM`,
`cachedInputPerM`, `cacheWrite5m/1hPerM`, plus the card used.

## The local model cards

The models observed in local OpenCode history:

| Card                       | Provider       | Input | Cached read | Output | Notes                                                                                   |
| -------------------------- | -------------- | ----- | ----------- | ------ | --------------------------------------------------------------------------------------- |
| `gpt-oss:120b`             | `ollama-cloud` | $0.15 | $0.014      | $0.60  | Explicit cached rate; reproduces the observed charge exactly (delta 0 on the snapshot). |
| `gpt-oss:20b`              | `ollama-cloud` | $0.07 | $0.035      | $0.30  | Explicit cached rate.                                                                   |
| `deepseek-v4.1-flash-free` | `opencode`     | $0    | $0          | $0     | Explicit `$0` card.                                                                     |
| `glm-5.3-flash-free`       | `opencode`     | $0    | $0          | $0     | Explicit `$0` card.                                                                     |

`gpt-oss:120b` is the strongest validation available: local history records
observed charges that match Munin's estimate to the last digit, because the
explicit cached rate and the write-multiplier line up with how Ollama bills.

Visitors and recommendations use the same registry: cards for paid frontier
models exist in `anthropic.ts`, `openai.ts`, and `google.ts`, with
long-context bands and server-tool prices where the provider bills them.

## Free and unpriced policy

Two different states that a careless `$0` would merge (docs/adr/0007):

1. **Free tier** — an explicit `$0` card. The call is priced; the estimate is
   exactly $0; `unpriced` stays false; no dollars can exist to recover. Free
   ids resolve **only** to their own exact card: resolution never
   prefix-matches onto a paid sibling (`glm-5.3-flash-free` is a prefix
   extension of the paid `glm-5.3-flash`), so a free id can never bill you.
2. **Unpriced** — no card for the model at all. Report the call and its
   tokens; withhold the dollars (`estimatedUsd: null`, `cost.unpriced`), warn
   once per model (`price.unpriced-model`, with the call count and any
   observed spend), and never list the model as `$0` spend.

## How to add or update a price

1. Open `packages/core/src/pricing/catalogue/` and pick the provider file (or
   `open.ts` for open-weight/gateway models).
2. Add or amend the card entry: id as the **source reports it**, provider
   string matching `providers.ts` policy, `from` date, and a provenance label
   with the date you checked the price.
3. Do not edit history: a changed rate gets a new `rates` entry with its own
   `from`, so old calls keep their old price.
4. Bump `PRICING_VERSION` in `pricing/providers.ts` (and only `PRICING_AS_OF`
   when you re-check the entire catalogue). Both constants live in one place;
   the report reads them from there.

5. Run:

   ```bash
   npm run build && npm test
   ```

   `tests/unit/pricing.test.mjs` pins exact dollars, dated card changes,
   long-context bands, observed-zero, unpriced, and free-id cases; adjust the
   fixture expectations only if you _intended_ the price change to rescale them.

6. If the new model appeared in real traffic, re-check with a fresh snapshot:

   ```bash
   npm run analyze -- --db /tmp/munin-snapshot.db --models
   ```

   The invariant: unpriced rows gain a card and disappear from
   `dataHealth.unpricedModels`; free rows gain explicit `$0` cards, never
   inherited ones.
