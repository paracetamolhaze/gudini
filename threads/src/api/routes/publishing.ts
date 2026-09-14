import type { FastifyInstance } from "fastify";
import { listDrafts } from "../../db/repos/drafts.js";
import { listPublications } from "../../db/repos/publishing.js";
import { query, one } from "../../db/pool.js";
import { clampInt } from "../../shared/ids.js";
import { HttpError } from "../server.js";
import { loadSettings } from "../../config/settings.js";
import { decideSlot } from "../../services/publishing/schedule.js";
import { lastPublishedAt, postsPublishedToday } from "../../db/repos/publishing.js";

export function registerPublishingRoutes(app: FastifyInstance, api: string): void {
  /** Queue: approved/scheduled/publishing drafts with the slot the scheduler would give them. */
  app.get(`${api}/queue`, async () => {
    const settings = await loadSettings();
    const drafts = await listDrafts({ status: ["APPROVED", "SCHEDULED", "PUBLISHING", "FAILED"], limit: 100 });
    const lastAt = await lastPublishedAt();
    const postsToday = await postsPublishedToday(settings.schedule.timezone);
    const now = new Date();
    return {
      lastPublishedAt: lastAt,
      postsToday,
      limits: { maxPostsPerDay: settings.schedule.maximumPostsPerDay, minimumMinutesBetweenPosts: settings.schedule.minimumMinutesBetweenPosts, preferredHours: settings.schedule.preferredHours, timezone: settings.schedule.timezone },
      queue: drafts.map((d) => ({
        ...d,
        slot: decideSlot({
          now,
          lastPublishedAt: lastAt,
          postsToday,
          maxPostsPerDay: settings.schedule.maximumPostsPerDay,
          minimumMinutesBetweenPosts: settings.schedule.minimumMinutesBetweenPosts,
          preferredHours: settings.schedule.preferredHours,
          timezone: settings.schedule.timezone,
          priority: d.priority,
        }),
      })),
    };
  });

  app.get(`${api}/published`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return { publications: await listPublications(clampInt(q.limit, 1, 200, 50), q.before) };
  });

  app.get(`${api}/published/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const publication = await one(`SELECT * FROM publications WHERE id = $1`, [id]);
    if (!publication) throw new HttpError(404, "publication not found");
    const snapshots = await query(`SELECT * FROM insight_snapshots WHERE publication_id = $1 ORDER BY captured_at ASC`, [id]);
    const interactions = await query(`SELECT * FROM interactions WHERE publication_id = $1 ORDER BY created_at DESC`, [id]);
    return { publication, snapshots, interactions };
  });
}
