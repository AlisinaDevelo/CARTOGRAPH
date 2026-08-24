declare module "express" {
  export interface Request {
    body: unknown;
  }

  export interface Response {
    json(value: unknown): void;
    send(value: unknown): void;
  }

  type Handler = (request: Request, response: Response) => unknown;

  export interface ExpressApp {
    get(path: string, ...handlers: Handler[]): ExpressApp;
    get(...handlers: Handler[]): ExpressApp;
    post(path: string, ...handlers: Handler[]): ExpressApp;
    put(path: string, ...handlers: Handler[]): ExpressApp;
    patch(path: string, ...handlers: Handler[]): ExpressApp;
    delete(path: string, ...handlers: Handler[]): ExpressApp;
    use(...handlers: Handler[]): ExpressApp;
    use(path: string, ...handlers: Handler[]): ExpressApp;
    route(path: string): ExpressApp;
  }

  function express(): ExpressApp;
  function Router(): ExpressApp;
  export default express;
  export { Router };
}
