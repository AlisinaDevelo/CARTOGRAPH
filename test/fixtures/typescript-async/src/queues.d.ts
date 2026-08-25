declare module "bullmq" {
  export class Queue {
    constructor(name: string);
    add(job: string, payload: unknown): Promise<void>;
    addBulk(jobs: unknown[]): Promise<void>;
  }

  export class Worker {
    constructor(name: string, handler: (job: unknown) => unknown);
  }
}

declare module "bull" {
  class Queue {
    constructor(name: string);
    add(job: string, payload: unknown): Promise<void>;
    process(handler: (job: unknown) => unknown): void;
    process(job: string, handler: (job: unknown) => unknown): void;
  }

  export default Queue;
}
