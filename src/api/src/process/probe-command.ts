/** Execute a command to verify it is runnable, bounded by a short timeout. */
export async function probeCommand(binary: string, args: readonly string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn([binary, ...args], { stdout: 'ignore', stderr: 'ignore' });
    const timer = setTimeout(() => proc.kill(), 5_000);
    try {
      return (await proc.exited) === 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
