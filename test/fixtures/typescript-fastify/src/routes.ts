import fastify from "fastify";

import { createUser, health, listUsers, plugin } from "./handlers.js";

const app = fastify();
const dynamicPath = process.env.FASTIFY_PATH ?? "/runtime";
const dynamicMethod = process.env.FASTIFY_METHOD ?? "get";

app.get("/users", listUsers);
app.post({ url: "/users", handler: createUser });
app.route({ method: "GET", url: "/users/:id", handler: listUsers });
app.route({ method: ["HEAD", "OPTIONS"], url: "/health", handler: health });
app.register(plugin, { prefix: "/plugins" });

app.get(dynamicPath, listUsers);
app.route({ method: dynamicMethod, url: "/dynamic", handler: listUsers });
/* eslint-disable @typescript-eslint/no-unsafe-call */
// @ts-expect-error The fixture intentionally exercises a computed Fastify method.
app[dynamicMethod]("/computed", listUsers);
/* eslint-enable @typescript-eslint/no-unsafe-call */
// @ts-expect-error The fixture intentionally exercises a missing Fastify handler.
app.route({ method: "GET", url: "/missing" });

void app;
