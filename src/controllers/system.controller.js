import { getModelQuotas, getSubscriptionTier } from "../cloudcode/index.js";
import { forceRefresh } from "../auth/token-extractor.js";
import { MAX_CONCURRENT_REQUESTS } from "../constants.js";
import { logger } from "../utils/logger.js";
import { formatDuration } from "../utils/helpers.js";
import { config } from "../config.js";
import usageStats from "../modules/usage-stats.js";

export const createSystemController = (accountManager, ensureInitialized) => {
  return {
    healthCheck: async (req, res, next) => {
      try {
        await ensureInitialized();
        const start = Date.now();

        // Get high-level status first
        const status = accountManager.getStatus();
        const allAccounts = accountManager.getAllAccounts();

        // Fetch quotas for each account in parallel to get detailed model info
        const accountDetails = await Promise.allSettled(
          allAccounts.map(async (account) => {
            // Check model-specific rate limits
            const activeModelLimits = Object.entries(
              account.modelRateLimits || {}
            ).filter(
              ([_, limit]) =>
                limit.isRateLimited && limit.resetTime > Date.now()
            );
            const isRateLimited = activeModelLimits.length > 0;
            const soonestReset =
              activeModelLimits.length > 0
                ? Math.min(...activeModelLimits.map(([_, l]) => l.resetTime))
                : null;

            const baseInfo = {
              email: account.email,
              lastUsed: account.lastUsed
                ? new Date(account.lastUsed).toISOString()
                : null,
              modelRateLimits: account.modelRateLimits || {},
              rateLimitCooldownRemaining: soonestReset
                ? Math.max(0, soonestReset - Date.now())
                : 0,
            };

            // Skip invalid accounts for quota check
            if (account.isInvalid) {
              return {
                ...baseInfo,
                status: "invalid",
                error: account.invalidReason,
                models: {},
              };
            }

            try {
              const token = await accountManager.getTokenForAccount(account);
              const quotas = await getModelQuotas(token);

              // Merge local rate limit tracking with API quotas
              // Local tracking takes precedence when rate-limited
              const now = Date.now();
              const localLimits = account.modelRateLimits || {};

              // Format quotas for readability
              const formattedQuotas = {};
              for (const [modelId, info] of Object.entries(quotas)) {
                // Check if locally rate-limited for this model
                const localLimit = localLimits[modelId];
                if (localLimit?.isRateLimited && localLimit.resetTime > now) {
                  // Override with local rate limit data
                  formattedQuotas[modelId] = {
                    remaining: "0%",
                    remainingFraction: 0,
                    resetTime: new Date(localLimit.resetTime).toISOString(),
                  };
                } else {
                  formattedQuotas[modelId] = {
                    remaining:
                      info.remainingFraction !== null
                        ? `${Math.round(info.remainingFraction * 100)}%`
                        : "N/A",
                    remainingFraction: info.remainingFraction,
                    resetTime: info.resetTime || null,
                  };
                }
              }

              // Add models that are locally rate-limited but not in API response
              for (const [modelId, limit] of Object.entries(localLimits)) {
                if (
                  limit.isRateLimited &&
                  limit.resetTime > now &&
                  !formattedQuotas[modelId]
                ) {
                  formattedQuotas[modelId] = {
                    remaining: "0%",
                    remainingFraction: 0,
                    resetTime: new Date(limit.resetTime).toISOString(),
                  };
                }
              }

              return {
                ...baseInfo,
                status: isRateLimited ? "rate-limited" : "ok",
                models: formattedQuotas,
              };
            } catch (error) {
              return {
                ...baseInfo,
                status: "error",
                error: error.message,
                models: {},
              };
            }
          })
        );

        // Process results
        const detailedAccounts = accountDetails.map((result, index) => {
          if (result.status === "fulfilled") {
            return result.value;
          } else {
            const acc = allAccounts[index];
            return {
              email: acc.email,
              status: "error",
              error: result.reason?.message || "Unknown error",
              modelRateLimits: acc.modelRateLimits || {},
            };
          }
        });

        res.json({
          status: "ok",
          timestamp: new Date().toISOString(),
          latencyMs: Date.now() - start,
          summary: status.summary,
          counts: {
            total: status.total,
            available: status.available,
            rateLimited: status.rateLimited,
            invalid: status.invalid,
          },
          accounts: detailedAccounts,
        });
      } catch (error) {
        logger.error("[API] Health check failed:", error);
        res.status(503).json({
          status: "error",
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    },

    getAccountLimits: async (req, res, next) => {
      try {
        await ensureInitialized();
        const allAccounts = accountManager.getAllAccounts();
        const format = req.query.format || "json";
        const includeHistory = req.query.includeHistory === "true";

        // Fetch quotas for each account in parallel
        const results = await Promise.allSettled(
          allAccounts.map(async (account) => {
            // Skip invalid accounts
            if (account.isInvalid) {
              return {
                email: account.email,
                status: "invalid",
                error: account.invalidReason,
                models: {},
                localRateLimits: account.modelRateLimits || {},
              };
            }

            try {
              const token = await accountManager.getTokenForAccount(account);

              // Fetch both quotas and subscription tier in parallel
              const [quotas, subscription] = await Promise.all([
                getModelQuotas(token),
                getSubscriptionTier(token),
              ]);

              // Update account object with fresh data
              account.subscription = {
                tier: subscription.tier,
                projectId: subscription.projectId,
                detectedAt: Date.now(),
              };
              account.quota = {
                models: quotas,
                lastChecked: Date.now(),
              };

              // Save updated account data to disk (async, don't wait)
              accountManager.saveToDisk().catch((err) => {
                logger.error("[Server] Failed to save account data:", err);
              });

              // Merge local rate limit tracking with API quotas
              // Local tracking takes precedence when rate-limited
              const now = Date.now();
              const localLimits = account.modelRateLimits || {};
              const mergedQuotas = { ...quotas };

              for (const [modelId, limit] of Object.entries(localLimits)) {
                if (limit.isRateLimited && limit.resetTime > now) {
                  // Override API quota with local rate limit
                  mergedQuotas[modelId] = {
                    remainingFraction: 0,
                    resetTime: new Date(limit.resetTime).toISOString(),
                  };
                }
              }

              return {
                email: account.email,
                status: "ok",
                subscription: account.subscription,
                models: mergedQuotas,
                localRateLimits: localLimits,
              };
            } catch (error) {
              return {
                email: account.email,
                status: "error",
                error: error.message,
                subscription: account.subscription || {
                  tier: "unknown",
                  projectId: null,
                },
                models: {},
                localRateLimits: account.modelRateLimits || {},
              };
            }
          })
        );

        // Process results
        const accountLimits = results.map((result, index) => {
          if (result.status === "fulfilled") {
            return result.value;
          } else {
            const acc = allAccounts[index];
            return {
              email: acc.email,
              status: "error",
              error: result.reason?.message || "Unknown error",
              models: {},
              localRateLimits: acc.modelRateLimits || {},
            };
          }
        });

        // Collect all unique model IDs (from both API and local rate limits)
        const allModelIds = new Set();
        for (const account of accountLimits) {
          for (const modelId of Object.keys(account.models || {})) {
            allModelIds.add(modelId);
          }
          // Also include models from local rate limits that might not be in API response
          for (const modelId of Object.keys(account.localRateLimits || {})) {
            allModelIds.add(modelId);
          }
        }

        const sortedModels = Array.from(allModelIds).sort();

        // Return ASCII table format
        if (format === "table") {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");

          // Build table
          const lines = [];
          const timestamp = new Date().toLocaleString();
          lines.push(`Account Limits (${timestamp})`);

          // Get account status info
          const status = accountManager.getStatus();
          lines.push(
            `Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid`
          );
          lines.push("");

          // Table 1: Account status
          const accColWidth = 25;
          const statusColWidth = 15;
          const activeColWidth = 12;
          const lastUsedColWidth = 25;
          const resetColWidth = 25;

          let accHeader =
            "Account".padEnd(accColWidth) +
            "Status".padEnd(statusColWidth) +
            "Active".padEnd(activeColWidth) +
            "Last Used".padEnd(lastUsedColWidth) +
            "Quota Reset";
          lines.push(accHeader);
          lines.push(
            "─".repeat(
              accColWidth +
                statusColWidth +
                activeColWidth +
                lastUsedColWidth +
                resetColWidth
            )
          );

          for (const acc of status.accounts) {
            const shortEmail = acc.email.split("@")[0].slice(0, 22);
            const lastUsed = acc.lastUsed
              ? new Date(acc.lastUsed).toLocaleString()
              : "never";
            const activeStr = `${
              acc.activeRequests || 0
            }/${MAX_CONCURRENT_REQUESTS}`;

            // Get status and error from accountLimits
            const accLimit = accountLimits.find((a) => a.email === acc.email);
            let accStatus;
            if (acc.isInvalid) {
              accStatus = "invalid";
            } else if (accLimit?.status === "error") {
              accStatus = "error";
            } else {
              // Count exhausted models (0% or null remaining)
              const models = accLimit?.models || {};
              const modelCount = Object.keys(models).length;
              const exhaustedCount = Object.values(models).filter(
                (q) => q.remainingFraction === 0 || q.remainingFraction === null
              ).length;

              if (exhaustedCount === 0) {
                accStatus = "ok";
              } else {
                accStatus = `(${exhaustedCount}/${modelCount}) limited`;
              }
            }

            // Get reset time from quota API
            const claudeModel = sortedModels.find((m) => m.includes("claude"));
            const quota = claudeModel && accLimit?.models?.[claudeModel];
            const resetTime = quota?.resetTime
              ? new Date(quota.resetTime).toLocaleString()
              : "-";

            let row =
              shortEmail.padEnd(accColWidth) +
              accStatus.padEnd(statusColWidth) +
              activeStr.padEnd(activeColWidth) +
              lastUsed.padEnd(lastUsedColWidth) +
              resetTime;

            // Add error on next line if present
            if (accLimit?.error) {
              lines.push(row);
              lines.push("  └─ " + accLimit.error);
            } else {
              lines.push(row);
            }
          }
          lines.push("");

          // Calculate column widths - need more space for reset time info
          const modelColWidth =
            Math.max(28, ...sortedModels.map((m) => m.length)) + 2;
          const accountColWidth = 30;

          // Header row
          let header = "Model".padEnd(modelColWidth);
          for (const acc of accountLimits) {
            const shortEmail = acc.email.split("@")[0].slice(0, 26);
            header += shortEmail.padEnd(accountColWidth);
          }
          lines.push(header);
          lines.push(
            "─".repeat(modelColWidth + accountLimits.length * accountColWidth)
          );

          // Data rows
          for (const modelId of sortedModels) {
            let row = modelId.padEnd(modelColWidth);
            for (const acc of accountLimits) {
              const quota = acc.models?.[modelId];
              let cell;
              if (acc.status !== "ok" && acc.status !== "rate-limited") {
                cell = `[${acc.status}]`;
              } else if (!quota) {
                cell = "-";
              } else if (
                quota.remainingFraction === 0 ||
                quota.remainingFraction === null
              ) {
                // Show reset time for exhausted models
                if (quota.resetTime) {
                  const resetMs = new Date(quota.resetTime).getTime() - Date.now();
                  if (resetMs > 0) {
                    cell = `0% (wait ${formatDuration(resetMs)})`;
                  } else {
                    cell = "0% (resetting...)";
                  }
                } else {
                  cell = "0% (exhausted)";
                }
              } else {
                const pct = Math.round(quota.remainingFraction * 100);
                cell = `${pct}%`;
              }
              row += cell.padEnd(accountColWidth);
            }
            lines.push(row);
          }

          return res.send(lines.join("\n"));
        }

        // Get account metadata from AccountManager
        const accountStatus = accountManager.getStatus();
        const accountMetadataMap = new Map(
          accountStatus.accounts.map((a) => [a.email, a])
        );

        const responseData = {
          timestamp: new Date().toLocaleString(),
          totalAccounts: allAccounts.length,
          models: sortedModels,
          modelConfig: config.modelMapping || {},
          accounts: accountLimits.map((acc) => {
            // Merge quota data with account metadata
            const metadata = accountMetadataMap.get(acc.email) || {};
            return {
              email: acc.email,
              status: acc.status,
              error: acc.error || null,
              // Include metadata from AccountManager (WebUI needs these)
              source: metadata.source || "unknown",
              enabled: metadata.enabled !== false,
              projectId: metadata.projectId || null,
              isInvalid: metadata.isInvalid || false,
              invalidReason: metadata.invalidReason || null,
              lastUsed: metadata.lastUsed || null,
              modelRateLimits: metadata.modelRateLimits || {},
              // Subscription data (new)
              subscription: acc.subscription ||
                metadata.subscription || { tier: "unknown", projectId: null },
              // Quota limits
              limits: Object.fromEntries(
                sortedModels.map((modelId) => {
                  const quota = acc.models?.[modelId];
                  if (!quota) {
                    return [modelId, null];
                  }
                  return [
                    modelId,
                    {
                      remaining:
                        quota.remainingFraction !== null
                          ? `${Math.round(quota.remainingFraction * 100)}%`
                          : "N/A",
                      remainingFraction: quota.remainingFraction,
                      resetTime: quota.resetTime || null,
                    },
                  ];
                })
              ),
            };
          }),
        };

        // Optionally include usage history (for dashboard performance optimization)
        if (includeHistory) {
          responseData.history = usageStats.getHistory();
        }

        res.json(responseData);
      } catch (error) {
        next(error);
      }
    },

    refreshToken: async (req, res, next) => {
      try {
        await ensureInitialized();
        // Clear all caches
        accountManager.clearTokenCache();
        accountManager.clearProjectCache();
        // Force refresh default token
        const token = await forceRefresh();
        res.json({
          status: "ok",
          message: "Token caches cleared and refreshed",
          tokenPrefix: token.substring(0, 10) + "...",
        });
      } catch (error) {
        next(error);
      }
    },
  };
};
