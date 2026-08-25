declare module "express" {
  export interface Request {
    params: Record<string, string>;
  }

  export interface Response {
    json(value: unknown): void;
  }

  type Handler = (request: Request, response: Response) => unknown;

  export interface ExpressApp {
    get(path: string, ...handlers: Handler[]): ExpressApp;
    get(...handlers: Handler[]): ExpressApp;
    use(path: string, ...handlers: Handler[]): ExpressApp;
    use(...handlers: Handler[]): ExpressApp;
  }

  function express(): ExpressApp;
  export default express;
}
