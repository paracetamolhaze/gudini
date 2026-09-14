import { registerHandler } from "../index.js";
import { captureInsights } from "../../services/analytics/insights.js";
import { refreshRecommendations } from "../../services/analytics/recommendations.js";

registerHandler("analytics", "analytics:insights", async () => captureInsights());
registerHandler("analytics", "analytics:recommend", async () => refreshRecommendations());
