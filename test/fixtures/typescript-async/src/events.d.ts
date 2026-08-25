declare module "node:events" {
  export class EventEmitter {
    on(event: string, handler: (...args: unknown[]) => unknown): this;
    once(event: string, handler: (...args: unknown[]) => unknown): this;
    addListener(event: string, handler: (...args: unknown[]) => unknown): this;
    prependListener(
      event: string,
      handler: (...args: unknown[]) => unknown,
    ): this;
    emit(event: string, ...args: unknown[]): boolean;
  }
}
