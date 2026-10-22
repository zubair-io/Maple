/** Shared Node filesystem error lookup without publication dependencies. */
export function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}
