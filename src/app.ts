const express: any = require("express");
const crypto: any = require("node:crypto");
const { openDatabase, listTrackedCryptocurrencies } = require("./database");

export interface ApplicationConfig {
  apiToken: string;
  databasePath: string;
}

export interface Application {
  app: any;
  close: () => void;
}

function matchesToken(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

export function createApplication(config: ApplicationConfig): Application {
  const database = openDatabase(config.databasePath);
  const app = express();

  app.use("/api", (request: any, response: any, next: any) => {
    const authorization = request.get("authorization");
    const match = typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/.exec(authorization)
      : null;

    if (!match || !matchesToken(match[1], config.apiToken)) {
      response.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required",
        },
      });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "16kb" }));

  app.get("/api/tracked-cryptocurrencies", (_request: any, response: any) => {
    response.status(200).json(listTrackedCryptocurrencies(database));
  });

  app.use((_request: any, response: any) => {
    response.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Resource not found",
      },
    });
  });

  app.use((error: any, _request: any, response: any, _next: any) => {
    const isInvalidJson = error instanceof SyntaxError && "body" in error;
    if (isInvalidJson) {
      response.status(400).json({
        error: {
          code: "INVALID_JSON",
          message: "Request body must contain valid JSON",
        },
      });
      return;
    }
    response.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred",
      },
    });
  });

  return {
    app,
    close: () => database.close(),
  };
}
