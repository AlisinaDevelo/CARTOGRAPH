import { PrismaClient } from "@prisma/client";
import { PrismaClient as GeneratedClient } from "../generated/prisma/index.js";

const prisma = new PrismaClient();
const generated = new GeneratedClient();

export function listUsers() {
  return prisma.user.findMany();
}

export function generatedClientReference() {
  return generated;
}
