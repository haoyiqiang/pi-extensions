export interface CreateSurfaceOptions {
  /** Submit a shell command as part of terminal creation, without a separate send operation. */
  command?: string;
}

export interface BackendOps {
  create(name: string, options?: CreateSurfaceOptions): string;
  createSplit(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
    options?: CreateSurfaceOptions,
  ): string;
  send(surface: string, command: string): void;
  sendEscape(surface: string): void;
  read(surface: string, lines?: number): string;
  readAsync(surface: string, lines?: number): Promise<string>;
  close(surface: string): void;
  rename(surface: string, name: string): void;
}
