import express from "express";
import type { Request, Response } from "express";
import { db } from "./db.js";

const app = express();
const routePath = process.env.ROUTE_PATH ?? "";
const routeMethod = process.env.ROUTE_METHOD ?? "get";
const importPath = "./services.js";
const baseUrl = "https://api.example.test";
const modelName = "user";

// These constructs are intentionally outside the supported literal subset.
app.get(routePath, (_request, response) => response.send("dynamic"));
/* eslint-disable @typescript-eslint/no-unsafe-call */
// @ts-expect-error The fixture intentionally exercises a dynamic Express method.
app[routeMethod]("/dynamic-method", (_request: Request, response: Response) =>
  response.send("dynamic"),
);
/* eslint-enable @typescript-eslint/no-unsafe-call */
void import(importPath);
void fetch(`${baseUrl}/users`);
void db[modelName].findMany();
