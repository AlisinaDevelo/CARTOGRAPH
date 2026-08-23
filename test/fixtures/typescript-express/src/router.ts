import { listOne } from "./services.js";
import { Router } from "express";

const router = Router();

router.get("/users/:id", listOne);

export default router;
