export type MessageTask = () => Promise<void> | void;

export function createSerialMessageQueue(): (task: MessageTask) => void {
  let chain: Promise<unknown> = Promise.resolve();
  return (task) => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
  };
}
