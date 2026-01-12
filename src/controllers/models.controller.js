import { listModels } from "../cloudcode/index.js";
import { logger } from "../utils/logger.js";

export const createModelsController = (accountManager) => {
  return {
    listModels: async (req, res, next) => {
      try {
        const account = accountManager.pickNext();
        if (!account) {
          const error = new Error("No accounts available");
          error.type = "api_error";
          error.statusCode = 503;
          throw error;
        }
        const token = await accountManager.getTokenForAccount(account);
        const models = await listModels(token);
        res.json(models);
      } catch (error) {
        logger.error("[API] Error listing models:", error);
        next(error);
      }
    },
  };
};
