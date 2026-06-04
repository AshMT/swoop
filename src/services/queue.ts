type Job = () => Promise<void>;

interface QueueItem {
  id: string;
  job: Job;
  label: string;
}

class InMemoryQueue {
  private queue: QueueItem[] = [];
  private running = false;

  enqueue(id: string, label: string, job: Job): void {
    // Deduplicate by id
    if (this.queue.some((item) => item.id === id)) return;
    this.queue.push({ id, label, job });
    if (!this.running) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await item.job();
      } catch (err) {
        console.error(`[Queue] Job "${item.label}" failed:`, err);
      }
    }
    this.running = false;
  }

  get size(): number {
    return this.queue.length;
  }
}

export const jobQueue = new InMemoryQueue();
