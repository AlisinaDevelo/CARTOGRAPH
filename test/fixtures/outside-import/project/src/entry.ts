import { outsideSecret } from "../../outside-sentinel.js";

export function localFunction(): string {
  return outsideSecret();
}
