# Observed cost headlines; API-equivalent is secondary

Optimaizr headlined estimated API-equivalent spend because Claude subscriptions hide the meter. OpenCode records an actual cost per call, so Munin headlines what was observed and shows API-equivalent list pricing beside it, labelled. Savings remain derived from dated rate cards, because a rule needs per-token rates to say what a different model would have cost. When observed cost is zero, findings are marked estimated rather than implying money the user never spent.

## Consequences

- Every screen carries both numbers and a basis label.
- Unpriced models appear in data health instead of contributing a fake zero.
