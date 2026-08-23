import { Prisma, PrismaClient as RealPrismaClient } from "@prisma/client";

const localFetch = (value: string): number => value.length;

const ordinaryDb = {
  user: {
    findMany(): number {
      return 1;
    },
  },
};

export function ordinaryCalls(): number {
  const fetch = localFetch;
  return ordinaryDb.user.findMany() + fetch("not-a-request");
}

export function outerA(): number {
  function duplicate(): number {
    return 1;
  }

  return duplicate();
}

export function outerB(): number {
  function duplicate(): number {
    return 2;
  }

  return duplicate();
}

declare const db: {
  user: {
    findMany(): number[];
    [operation: string]: (...args: never[]) => unknown;
  };
};

const prisma = new RealPrismaClient();
const qualifiedPrisma = new Prisma.PrismaClient();

class PrismaClient {
  user!: {
    findMany(): number[];
  };
}

const fakePrisma = new PrismaClient();

export function bracketRead(): number[] {
  return db.user["findMany"]();
}

export function dynamicPrisma(operation: string): unknown {
  return db.user[operation]?.();
}

export function constructedPrismaRead(): number[] {
  return prisma.user.findMany();
}

export function qualifiedConstructedPrismaRead(): number[] {
  return qualifiedPrisma.user.findMany();
}

export function localPrismaLookalikeRead(): number[] {
  return fakePrisma.user.findMany();
}
