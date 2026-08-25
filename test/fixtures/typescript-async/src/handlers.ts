export function handleOrder(): void {}

export const handleRetry = (): void => {};

export function registerCallback(callback: () => void): void {
  callback();
}
