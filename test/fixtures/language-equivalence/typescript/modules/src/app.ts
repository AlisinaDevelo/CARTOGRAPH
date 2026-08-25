import { charge } from "./payments.js";

export function processOrder(): void {
  void charge();
}
