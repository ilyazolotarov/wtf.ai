/** Minimal typed listener set. Listeners run synchronously in subscription order. */
export class Emitter<Args extends unknown[]> {
  private listeners = new Set<(...args: Args) => void>();

  on(listener: (...args: Args) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(...args: Args): void {
    for (const listener of this.listeners) {
      try {
        listener(...args);
      } catch (error) {
        console.error("listener failed", error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
