const secretHandlerExpression = 42;

declare function route(path: string, handler: () => void): void;

export function sendSecretRequest(): Promise<Response> {
  return fetch(
    "https://user:password@api.example.test/path-secret?token=super-secret#fragment",
  );
}

void secretHandlerExpression;

// @ts-expect-error The handler expression is intentionally not callable.
route("/internal", secretHandlerExpression);

// @ts-expect-error The analyzer must treat data URLs as opaque external modules.
void import("data:text/javascript,embedded-source-secret");
// @ts-expect-error The analyzer must not serialize absolute file URLs.
void import("file:///Users/user/absolute-source-secret.ts");
