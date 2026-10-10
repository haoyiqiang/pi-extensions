# Pi Extensions

Shared vocabulary for delegated work and interactive subagents.

## Language

**Subagent (子代理)**:
An interactive child session created by a parent session to carry out one delegation. Several exchanges can contribute to the same delegation.
_Avoid_: Task, generation run when referring to the child session itself.

**Delegation (委派)**:
The work goal assigned by the parent to one subagent, including clarifications and corrections to that goal. An independent work goal is a new delegation, not another conversational exchange within the original one.
_Avoid_: Turn when referring to the assigned work goal.

**Interruption (中断)**:
Stopping the subagent's current execution without completing or cancelling its delegation. The child session remains available for corrections and continued work.
_Avoid_: Completion, cancellation.

**Completion (完成)**:
The subagent's explicit declaration that its delegated work is ready to return to the parent. Merely becoming idle or being interrupted is not completion.
_Avoid_: Idle, interruption.
