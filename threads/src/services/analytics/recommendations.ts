import { loadSettings } from "../../config/settings.js";
import { one, query } from "../../db/pool.js";
import { audit } from "../audit.js";
import { performanceReport, type PerfRow } from "./performance.js";

/**
 * Analytics may recommend, never rewrite. Each recommendation is a PROPOSED row with evidence;
 * a human accepts or rejects it and applies the change (prompt version, source priority, hours).
 */
export interface Recommendation {
  kind: "content" | "timing" | "source" | "format";
  title: string;
  body: string;
  evidence: unknown;
}

function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

export function deriveRecommendations(report: Awaited<ReturnType<typeof performanceReport>>, minPosts = 3): Recommendation[] {
  const out: Recommendation[] = [];
  const avg = report.totals.engagementRate;
  if (report.totals.posts < minPosts * 2 || avg === null) return out;
  const better = (rows: PerfRow[], label: string, kind: Recommendation["kind"]) => {
    for (const r of rows) {
      if (r.posts < minPosts || r.engagementRate === null) continue;
      const lift = r.engagementRate / avg - 1;
      if (lift >= 0.3) {
        out.push({ kind, title: `${label} «${r.key}» работает на ${Math.round(lift * 100)}% лучше среднего`, body: `${r.posts} публикаций, engagement ${pct(r.engagementRate)} против среднего ${pct(avg)}. Стоит дать этому больше места — правкой промпта или приоритета, а не автоматически.`, evidence: r });
      } else if (lift <= -0.35) {
        out.push({ kind, title: `${label} «${r.key}» слабее среднего на ${Math.round(-lift * 100)}%`, body: `${r.posts} публикаций, engagement ${pct(r.engagementRate)} против среднего ${pct(avg)}. Проверьте, стоит ли снижать приоритет.`, evidence: r });
      }
    }
  };
  better(report.byCategory, "Категория", "content");
  better(report.byType, "Формат", "format");
  better(report.byHour, "Час публикации", "timing");
  better(report.bySource, "Источник", "source");
  better(report.byLength, "Длина", "format");
  better(report.byHookKind, "Тип хука", "format");
  return out.slice(0, 12);
}

export async function refreshRecommendations(): Promise<{ created: number }> {
  const settings = await loadSettings();
  const report = await performanceReport(settings.schedule.timezone, 30);
  const recs = deriveRecommendations(report);
  let created = 0;
  for (const r of recs) {
    const exists = await one(`SELECT id FROM recommendations WHERE title = $1 AND created_at >= now() - interval '7 days'`, [r.title]);
    if (exists) continue;
    await query(`INSERT INTO recommendations (kind, title, body, evidence_json) VALUES ($1,$2,$3,$4::jsonb)`, [r.kind, r.title, r.body, JSON.stringify(r.evidence)]);
    await audit("RECOMMENDATION", r.title, {}, { body: r.body, evidence: r.evidence });
    created++;
  }
  return { created };
}
