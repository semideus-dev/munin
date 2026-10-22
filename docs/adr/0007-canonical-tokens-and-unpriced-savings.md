# Canonical tokens and unpriced savings

Optimaizr sized savings from menu-priced tokens and could always produce a dollar figure. Munin's source records one observed number per call and price cards are an overlay, so a finding on traffic the cards cannot price must not show a dollar. Such findings report their physical waste in canonical tokens (source output plus thinking as one billed output), set `windowUsd` to zero, and set `savings.unpriced` — a zero that means "unpriced", never "free". A real `$0` card is the opposite case: the call is priced, `unpriced` stays false, and no dollars can exist to recover. Every dollar figure carries the catalogue date it rests on, and every finding carries the affected calls, a per-event cost-weighted claim, its assumptions, and a plain-language calculation, so no finding exists without an explanation a user could reproduce.

## Consequences

- `SavingsEstimate` gains `tokensWasted`, `unpriced`, and `pricingAsOf`; the waste window is clamped to what the affected calls actually cost, and the clamp is stated in the assumptions when it fires.
- Findings claim per call, and totals de-overlap per call at the largest claim by tier, so overlapping rules cannot sum the same dollar twice.
- Detectors that throw are reported as `AnalysisError`s with their rule name, in findings and later data health; a crashed detector must never look like a clean `$0`.
- Monthly and annual figures project at the recent 30-day pace for windows longer than 30 days, measured back from the last call, so projections are deterministic on a fixed dataset.
