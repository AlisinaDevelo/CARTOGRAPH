import type { ValidateFunction } from "ajv";

export declare const verifyVendoredSchemas: () => string[];
export declare const createCycloneDx16Validator: () => ValidateFunction;
export declare const createSarif210Validator: () => ValidateFunction;
export declare const createInTotoStatementV1Validator: () => ValidateFunction;
