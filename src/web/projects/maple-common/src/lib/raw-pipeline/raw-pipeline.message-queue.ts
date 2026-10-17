export type MessageTask = () => Promise<void> | void;

export function createSerialMessageQueue(): (task: MessageTask) => void {
  let chain: Promise<unknown> = Promise.resolve();
  return (task) => {
    const next = chain.then(task);
    chain = next.catch((err: unknown) => {
      console.error('[raw-pipeline.worker] queued message failed:', err);
    });
  };
}
