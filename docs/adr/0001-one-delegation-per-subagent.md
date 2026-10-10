---
status: proposed
---

# Keep one delegation per subagent

For the planned subagent improvements, keep one delegation per subagent instead of introducing a reusable worker with several independently tracked tasks. Follow-up messages clarify or correct the existing goal; an independent delegation starts another subagent. This trades worker reuse for simpler result attribution, especially when a user interacts with the child session. Reuse the subagent handle as the delegation reference rather than adding a task identifier, task store, or ownership model without a concrete requirement. This records the design direction, not an implemented lifecycle change.
