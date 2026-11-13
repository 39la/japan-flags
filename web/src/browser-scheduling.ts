export function yieldToBrowser(): Promise<void> {
  // CPU work needs a task boundary, not a wait for the next display frame.
  if (typeof window !== "undefined") {
    const scheduler = (
      window as Window & {
        scheduler?: { yield?: () => Promise<void> };
      }
    ).scheduler;
    if (scheduler?.yield) return scheduler.yield();
  }
  return new Promise<void>((resolve) => {
    if (typeof window !== "undefined" && window.requestAnimationFrame) {
      window.requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}
