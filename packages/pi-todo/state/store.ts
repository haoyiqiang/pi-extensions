import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

export function sid(ctx: { sessionManager: { getSessionId(): string } }): string {
  return ctx.sessionManager.getSessionId() ?? "";
}

function freshState(): TaskState {
  return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

export class TodoStore {
  private readonly sessions = new Map<string, TaskState>();
  private activeRenderSession = "";

  getTodos(sessionId: string): readonly Task[] {
    return this.getState(sessionId).tasks;
  }

  getNextId(sessionId: string): number {
    return this.getState(sessionId).nextId;
  }

  getState(sessionId: string): TaskState {
    return this.sessions.get(sessionId) ?? freshState();
  }

  replaceState(sessionId: string, next: TaskState): void {
    this.sessions.set(sessionId, next);
  }

  commitState(sessionId: string, next: TaskState): void {
    this.sessions.set(sessionId, next);
  }

  evictSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getRenderState(): TaskState {
    return this.getState(this.activeRenderSession);
  }

  claimActiveRenderSession(sessionId: string): boolean {
    if (!sessionId || this.activeRenderSession) return this.activeRenderSession === sessionId;
    this.activeRenderSession = sessionId;
    return true;
  }

  setActiveRenderSession(sessionId: string): void {
    this.activeRenderSession = sessionId;
  }

  getActiveRenderSession(): string {
    return this.activeRenderSession;
  }

  clearActiveRenderSession(sessionId?: string): boolean {
    if (sessionId !== undefined && sessionId !== "" && sessionId !== this.activeRenderSession) return false;
    this.activeRenderSession = "";
    return true;
  }

  reset(): void {
    this.sessions.clear();
    this.activeRenderSession = "";
  }
}

const defaultStore = new TodoStore();
export function getDefaultTodoStore(): TodoStore { return defaultStore; }
export function getTodos(sessionId: string): readonly Task[] { return defaultStore.getTodos(sessionId); }
export function getNextId(sessionId: string): number { return defaultStore.getNextId(sessionId); }
export function getState(sessionId: string): TaskState { return defaultStore.getState(sessionId); }
export function replaceState(sessionId: string, next: TaskState): void { defaultStore.replaceState(sessionId, next); }
export function commitState(sessionId: string, next: TaskState): void { defaultStore.commitState(sessionId, next); }
export function evictSession(sessionId: string): void { defaultStore.evictSession(sessionId); }
export function getRenderState(): TaskState { return defaultStore.getRenderState(); }
export function setActiveRenderSession(sessionId: string): void { defaultStore.setActiveRenderSession(sessionId); }
export function getActiveRenderSession(): string { return defaultStore.getActiveRenderSession(); }
export function clearActiveRenderSession(sessionId?: string): boolean { return defaultStore.clearActiveRenderSession(sessionId); }
export function __resetState(): void { defaultStore.reset(); }
