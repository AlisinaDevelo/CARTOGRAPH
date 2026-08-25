import { EventEmitter as Emitter } from "node:events";
import { Queue as OrdersQueue, Worker as OrdersWorker } from "bullmq";
import BullQueue from "bull";

import { handleOrder, handleRetry, registerCallback } from "./handlers.js";

const emitter = new Emitter();
const eventName = process.env.EVENT_NAME ?? "runtime";

export function publishOrder(): void {
  emitter.emit("order.created", { id: "1" });
}

export function registerEvents(): void {
  emitter.on("order.created", handleOrder);
  emitter.once("order.retry", () => handleRetry());
  emitter.on(eventName, handleRetry);
  // @ts-expect-error The fixture intentionally exercises string-only reflection.
  emitter.on("order.reflected", "handleOrder");
}

const orders = new OrdersQueue("orders");
void orders.add("created", { id: "1" });

const dynamicQueueName = process.env.QUEUE_NAME ?? "runtime";
const dynamicOrders = new OrdersQueue(dynamicQueueName);
void dynamicOrders.add("created", { id: "2" });

const legacy = new BullQueue("legacy");
legacy.process("created", handleRetry);

new OrdersWorker("orders", handleOrder);

class CustomQueue {
  add(_job: string, _payload: unknown): void {}
}

const unsupported = new CustomQueue();
unsupported.add("created", { id: "3" });

export function scheduleRetry(): void {
  setTimeout(handleRetry, 1000);
  queueMicrotask(() => handleOrder());
}

export function passCallback(): void {
  registerCallback(handleRetry);
  // @ts-expect-error The fixture intentionally exercises string-only reflection.
  registerCallback("handleOrder");
}
