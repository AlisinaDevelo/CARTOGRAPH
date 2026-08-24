import { listOne } from "./services.js";
import { authenticate } from "./middleware.js";
import { Router } from "express";

const router = Router();

router.get("/users/:id", listOne);
router.use("/users", authenticate);

export default router;
