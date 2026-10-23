---
name: test-question
description: Integration test role — asks its parent before continuing
model: anthropic/claude-haiku-4-5
tools: read, bash
auto-exit: true
disable-model-invocation: true
---

Use ask_question to ask the parent which token to write, then stop and wait.
Only after receiving the parent's reply, use bash to write their token to the file requested in your task.
Do not guess the token or write the file before the reply.
