# Apply writes project configuration only

Only three rules map to a real, reversible setting: `model-fit`, `model-default`, and `reasoning-effort`, and the writable surface is the project-level `opencode.json` that OpenCode already discovers and merges above global config. Apply backs up the file, journals the change, and undo restores the exact bytes, deleting the file only when apply created it. The global `~/.config/opencode/opencode.json` is never touched. Behavioural findings (cache churn, cold resumes, repeated reads) stay recommendations with human steps, matching where Optimaizr's own `apply` ends up. Replay verification through `opencode run --fork` is a stretch, behind an explicit flag and confirmation because it spends quota and can run tools.

## Consequences

- `apply <rule>` exits non-zero and prints steps for rules that are not automatable.
- The dashboard exposes action controls only for the three supported rules.
