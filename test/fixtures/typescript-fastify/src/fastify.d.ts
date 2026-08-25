declare module "fastify" {
  type Handler = (request: unknown, reply: unknown) => unknown;

  interface RouteOptions {
    method: string | string[];
    url: string;
    handler: Handler;
  }

  interface FastifyInstance {
    get(path: string, ...handlers: Handler[]): FastifyInstance;
    post(path: string, ...handlers: Handler[]): FastifyInstance;
    post(options: { url: string; handler: Handler }): FastifyInstance;
    route(options: RouteOptions): FastifyInstance;
    register(plugin: unknown, options?: { prefix?: string }): FastifyInstance;
  }

  function fastify(): FastifyInstance;
  export default fastify;
}
