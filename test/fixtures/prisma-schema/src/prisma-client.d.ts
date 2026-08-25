declare module "@prisma/client" {
  export class PrismaClient {
    user: {
      findMany(): number[];
    };
  }

  export namespace Prisma {
    class PrismaClient {
      user: {
        findMany(): number[];
      };
    }
  }
}
