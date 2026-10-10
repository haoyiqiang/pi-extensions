---
status: proposed
---

# Steer completion results back to the parent

For the planned completion protocol, deliver the child result automatically and request parent continuation with steering, matching interactive-subagents rather than requiring a blocking CLI wait or queuing a follow-up. This prioritizes immediate coordination when the parent is already working, at the cost of potentially redirecting that work. The exception, if any, for an explicitly interrupted parent is still under discussion. This records the selected delivery direction, not existing pi-subagent runtime behavior.
