---
status: proposed
---

# Completion closes the subagent; interruption preserves it

For the planned completion protocol, subagent_done reports the final delegation result and closes the child session and its panel. Do not introduce an autoExit parameter at this stage: one subagent owns one delegation, and user interaction remains available by interrupting the current execution before completion. Interruption alone leaves the delegation unfinished and preserves the child session for further input. This supersedes the earlier discussion of optional automatic exit; it describes the agreed design direction, not existing runtime behavior.
