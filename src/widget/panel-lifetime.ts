const released = new WeakSet<object>();

/** Mark before calling host code, so recursive closure never destroys content twice. */
export function releasePanel(handle: { destroy(): void } | null | undefined): void {
  if (!handle || released.has(handle)) return;
  released.add(handle);
  handle.destroy();
}
