import { query } from "../../db/pool.js";

/**
 * Content performance from the latest snapshot per publication. Engagement rate =
 * (likes + replies + reposts + quotes) / views. Grouped by the dimensions the operator can act on.
 */
export interface PerfRow {
  key: string;
  posts: number;
  views: number;
  engagementRate: number | null;
  repliesPerView: number | null;
  likesPerView: number | null;
}

const LATEST = `
  WITH latest AS (
    SELECT DISTINCT ON (s.publication_id) s.*
    FROM insight_snapshots s ORDER BY s.publication_id, s.captured_at DESC
  ),
  base AS (
    SELECT p.id, p.published_at, p.candidate_id, p.source_post_id, p.meta_json,
           c.topic, c.category, sp.source_id, src.name AS source_name,
           COALESCE(l.views,0) AS views, COALESCE(l.likes,0) AS likes, COALESCE(l.replies,0) AS replies, COALESCE(l.reposts,0) AS reposts, COALESCE(l.quotes,0) AS quotes,
           length(p.published_text) AS len,
           EXTRACT(HOUR FROM p.published_at AT TIME ZONE $1)::int AS hour,
           EXTRACT(ISODOW FROM p.published_at AT TIME ZONE $1)::int AS weekday,
           COALESCE(p.meta_json->>'type', 'NEWS') AS post_type,
           split_part(p.published_text, E'\\n', 1) AS hook
    FROM publications p
    LEFT JOIN latest l ON l.publication_id = p.id
    LEFT JOIN content_candidates c ON c.id = p.candidate_id
    LEFT JOIN source_posts sp ON sp.id = p.source_post_id
    LEFT JOIN sources src ON src.id = sp.source_id
    WHERE p.dry_run = false AND p.published_at >= now() - make_interval(days => $2)
  )`;

function groupQuery(expr: string): string {
  return `${LATEST}
    SELECT ${expr} AS key, count(*)::int AS posts, sum(views)::int AS views,
      CASE WHEN sum(views) > 0 THEN (sum(likes+replies+reposts+quotes)::float / sum(views)) ELSE NULL END AS "engagementRate",
      CASE WHEN sum(views) > 0 THEN (sum(replies)::float / sum(views)) ELSE NULL END AS "repliesPerView",
      CASE WHEN sum(views) > 0 THEN (sum(likes)::float / sum(views)) ELSE NULL END AS "likesPerView"
    FROM base GROUP BY 1 ORDER BY posts DESC, views DESC LIMIT 40`;
}

export async function performanceReport(timezone: string, days = 30): Promise<{
  totals: { posts: number; views: number; engagementRate: number | null; replies: number; likes: number };
  byCategory: PerfRow[];
  byType: PerfRow[];
  byHour: PerfRow[];
  byWeekday: PerfRow[];
  bySource: PerfRow[];
  byLength: PerfRow[];
  byHookKind: PerfRow[];
}> {
  const params = [timezone, days];
  const totals = await query<{ posts: number; views: number; engagementRate: number | null; replies: number; likes: number }>(
    `${LATEST} SELECT count(*)::int AS posts, COALESCE(sum(views),0)::int AS views, COALESCE(sum(replies),0)::int AS replies, COALESCE(sum(likes),0)::int AS likes,
       CASE WHEN sum(views) > 0 THEN (sum(likes+replies+reposts+quotes)::float / sum(views)) ELSE NULL END AS "engagementRate" FROM base`,
    params,
  );
  const [byCategory, byType, byHour, byWeekday, bySource, byLength, byHookKind] = await Promise.all([
    query<PerfRow>(groupQuery("COALESCE(category, 'other')"), params),
    query<PerfRow>(groupQuery("post_type"), params),
    query<PerfRow>(groupQuery("lpad(hour::text, 2, '0') || ':00'"), params),
    query<PerfRow>(groupQuery("(ARRAY['пн','вт','ср','чт','пт','сб','вс'])[weekday]"), params),
    query<PerfRow>(groupQuery("COALESCE(source_name, 'без источника')"), params),
    query<PerfRow>(groupQuery("CASE WHEN len < 200 THEN 'до 200' WHEN len < 400 THEN '200–400' WHEN len < 500 THEN '400–500' ELSE 'тред' END"), params),
    query<PerfRow>(groupQuery("CASE WHEN hook ~ '\\?' THEN 'вопрос' WHEN hook ~ '\\d' THEN 'цифра' WHEN length(hook) < 60 THEN 'короткий' ELSE 'длинный' END"), params),
  ]);
  return { totals: totals[0] ?? { posts: 0, views: 0, engagementRate: null, replies: 0, likes: 0 }, byCategory, byType, byHour, byWeekday, bySource, byLength, byHookKind };
}
