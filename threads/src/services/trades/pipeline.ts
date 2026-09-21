import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { loadSettings, type Settings } from "../../config/settings.js";
import { one, query } from "../../db/pool.js";
import { insertDraft, recentPublishedTexts } from "../../db/repos/drafts.js";
import { fillsForCoin, getTrade, insertFills, knownLeverage, lastFillTime, listTrades, rememberLeverage, tradePostsToday, updateTrade, upsertTrade, type TradeRow } from "../../db/repos/trades.js";
import { hyperliquid, isPerpCoin, isWalletAddress } from "../../hyperliquid/client.js";
import { defaultTargets } from "../../platforms/index.js";
import { errorMessage } from "../../shared/logger.js";
import { newId } from "../../shared/ids.js";
import { audit } from "../audit.js";
import { buildTradesForCoin, roePct, worthPosting } from "./aggregate.js";
import { CARD_HEIGHT, CARD_WIDTH, renderTradeCard, shortWallet } from "./card.js";
import { tradeFacts, tradeMarketContext, writeTradePost } from "./writer.js";

/**
 * Hyperliquid → trades → card + post.
 *   trades:sync   pulls new fills for the owner's wallet (public, read-only), rebuilds the trades of
 *                 the coins that changed and drafts a post for every freshly closed winner above
 *                 the owner's bar (daily cap applies). Losing trades never become posts.
 *   trades:draft  renders the card and writes the text for one trade (also used by the dashboard).
 */
export function tradeWallet(settings: Settings): string {
  return (settings.trades.wallet || env().HYPERLIQUID_WALLET || "").trim();
}

const INTERVALS: Array<[string, number]> = [["1m", 60_000], ["5m", 300_000], ["15m", 900_000], ["1h", 3_600_000], ["4h", 14_400_000], ["1d", 86_400_000]];

async function candlesFor(trade: TradeRow): Promise<Array<{ t: number; c: number }>> {
  if (!trade.closed_at) return [];
  const life = Math.max(30 * 60_000, trade.closed_at.getTime() - trade.opened_at.getTime());
  const pad = Math.max(20 * 60_000, life * 0.25);
  const from = trade.opened_at.getTime() - pad;
  const to = Math.min(Date.now(), trade.closed_at.getTime() + pad * 0.4);
  const [interval] = INTERVALS.find(([, ms]) => (to - from) / ms <= 160) ?? INTERVALS[INTERVALS.length - 1]!;
  const candles = await hyperliquid().candles(trade.coin, interval, from, to);
  return candles.map((c) => ({ t: c.t, c: Number(c.c) })).filter((c) => Number.isFinite(c.c));
}

export async function renderCardForTrade(trade: TradeRow, settings: Settings): Promise<{ assetId: string; file: string; candles: Array<{ t: number; c: number }> }> {
  if (trade.status !== "CLOSED" || trade.exit_px === null || !trade.closed_at) throw new Error("карточка рисуется только для закрытой сделки");
  const candles = await candlesFor(trade).catch(() => []);
  const image = await renderTradeCard(
    { coin: trade.coin, direction: trade.direction, leverage: trade.leverage, entryPx: trade.entry_px, exitPx: trade.exit_px, netPnl: trade.net_pnl, roePct: trade.roe_pct, movePct: trade.move_pct, openedAt: trade.opened_at, closedAt: trade.closed_at, size: trade.max_size, candles },
    // The card carries the full address on purpose: the point is that the trade can be checked in the explorer.
    { showUsd: settings.trades.showUsd, showSize: settings.trades.showSize, wallet: settings.trades.showWallet ? trade.wallet : null, handle: settings.trades.handle, language: settings.platforms.x.enabled && settings.platforms.x.language === "en" && !settings.platforms.threads.enabled ? "en" : "ru", timezone: settings.schedule.timezone },
  );
  const assetId = newId();
  const dir = path.join(env().DATA_DIR, "media", assetId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "final.jpg");
  await writeFile(file, image);
  await query(
    `INSERT INTO media_assets (id, original_url, local_path, final_path, media_type, width, height, status) VALUES ($1, $2, $3, $3, 'image', $4, $5, 'QA_PASSED')`,
    [assetId, `generated:trade-card:${trade.id}`, file, CARD_WIDTH, CARD_HEIGHT],
  );
  await updateTrade(trade.id, { card_asset_id: assetId });
  return { assetId, file, candles };
}

export type TradeDraftOutcome = { kind: "draft"; draftId: string; status: string } | { kind: "skipped"; reason: string };

export async function createTradeDraft(tradeId: string, opts: { manual: boolean }): Promise<TradeDraftOutcome> {
  const settings = await loadSettings(true);
  const trade = await getTrade(tradeId);
  if (!trade) return { kind: "skipped", reason: "сделка не найдена" };
  if (trade.status !== "CLOSED") return { kind: "skipped", reason: "позиция ещё открыта" };
  if (!(trade.net_pnl > 0)) return { kind: "skipped", reason: "минусовые сделки не публикуются" };
  if (trade.draft_id) {
    const live = await one<{ id: string; status: string }>(`SELECT id, status FROM drafts WHERE id = $1 AND status NOT IN ('REJECTED','FAILED','EXPIRED')`, [trade.draft_id]);
    if (live) return { kind: "draft", draftId: live.id, status: live.status };
  }
  const targets = defaultTargets(settings);
  const { assetId, candles } = await renderCardForTrade(trade, settings);
  // The candles behind the card also explain the trade, so the writer gets the same picture the card shows.
  const context = tradeMarketContext(trade, candles);
  const facts = tradeFacts(trade, { showUsd: settings.trades.showUsd, showSize: settings.trades.showSize }, context);
  const examples = await query<{ text: string }>(`SELECT text FROM style_examples WHERE enabled ORDER BY rating DESC, created_at DESC LIMIT 5`);
  let post;
  try {
    post = await writeTradePost({ trade, facts, context, settings, forX: targets.includes("x"), styleExamples: examples.map((e) => e.text), recentPosts: await recentPublishedTexts(8), refs: {} });
  } catch (err) {
    await audit("POST_VALIDATION_FAILED", `Пост о сделке ${trade.coin} не написан: ${errorMessage(err)}`, {}, { tradeId }, "error");
    throw err;
  }
  const blocking = post.violations.some((v) => v.severity === "block");
  const needsReview = blocking || post.reviewReasons.length > 0;
  const summary = `${trade.coin} ${trade.direction} · ${trade.roe_pct !== null ? `ROE ${trade.roe_pct.toFixed(1)}%` : `${(trade.move_pct ?? 0).toFixed(1)}%`}${settings.trades.showUsd ? ` · $${trade.net_pnl.toFixed(2)}` : ""}`;
  const draft = await insertDraft({
    candidateId: null,
    kind: "TRADE",
    type: "TRADE",
    platforms: targets,
    text: post.text,
    textX: post.textX,
    tradeId: trade.id,
    facts,
    imageAssetId: assetId,
    hook: null,
    body: null,
    sourceSummary: summary,
    sourceUrls: [],
    confidence: post.confidence,
    // Own verified fills: nothing external to get wrong, so the risk gate only looks at the text checks.
    riskScore: blocking ? 60 : 10,
    status: needsReview ? "NEEDS_REVIEW" : "DRAFT",
    reviewReason: needsReview ? post.reviewReasons.join("; ") : null,
    priority: "P1",
    promptVersion: "trade_post_v2",
    model: post.model,
    validation: { violations: post.violations },
    variants: [],
    expiresAt: new Date(Date.now() + 72 * 3_600_000),
  });
  await query(`UPDATE media_assets SET draft_id = $2 WHERE id = $1`, [assetId, draft.id]);
  await updateTrade(trade.id, { post_status: "DRAFTED", draft_id: draft.id, skip_reason: null });
  await audit(needsReview ? "POST_NEEDS_REVIEW" : "POST_GENERATED", `Пост о сделке ${summary}${opts.manual ? " (по кнопке)" : ""}: ${post.text.slice(0, 140)}${needsReview ? `\nПричины: ${post.reviewReasons.join("; ")}` : ""}`, { draftId: draft.id }, { tradeId: trade.id }, needsReview ? "warn" : "info");
  return { kind: "draft", draftId: draft.id, status: draft.status };
}

export interface TradeSyncResult {
  wallet: string | null;
  newFills: number;
  tradesTouched: number;
  closedNow: number;
  drafted: number;
  error: string | null;
}

export async function syncTrades(): Promise<TradeSyncResult> {
  const settings = await loadSettings(true);
  const wallet = tradeWallet(settings);
  const result: TradeSyncResult = { wallet: wallet || null, newFills: 0, tradesTouched: 0, closedNow: 0, drafted: 0, error: null };
  if (!settings.trades.enabled) return { ...result, error: "сделки выключены в настройках" };
  if (!wallet) return { ...result, error: "адрес кошелька Hyperliquid не указан" };
  if (!isWalletAddress(wallet)) return { ...result, error: "адрес кошелька должен быть вида 0x… (42 символа)" };
  const hl = hyperliquid();

  // Leverage is only reported for open positions — remember it while it is visible.
  const state = await hl.clearinghouseState(wallet).catch(() => null);
  for (const p of state?.assetPositions ?? []) {
    if (p.position?.coin && typeof p.position.leverage?.value === "number") await rememberLeverage(wallet, p.position.coin, p.position.leverage.value);
  }

  const last = await lastFillTime(wallet);
  const windowStart = Date.now() - settings.trades.lookbackDays * 86_400_000;
  const since = last ? Math.max(windowStart, last.getTime() - 3_600_000) : windowStart;
  const fills = (await hl.userFillsSince(wallet, since)).filter((f) => isPerpCoin(f.coin));
  const { inserted, coins } = await insertFills(wallet, fills);
  result.newFills = inserted;

  for (const coin of coins) {
    const built = buildTradesForCoin(await fillsForCoin(wallet, coin));
    for (const t of built) {
      let leverage = await knownLeverage(wallet, coin);
      if (leverage === null && t.status === "CLOSED") {
        leverage = await hl.leverageFor(wallet, coin).catch(() => null);
        if (leverage !== null) await rememberLeverage(wallet, coin, leverage);
      }
      const { justClosed } = await upsertTrade(wallet, t, leverage, roePct(t, leverage));
      result.tradesTouched++;
      if (justClosed) result.closedNow++;
    }
  }

  // Trades closed within the last day that still have no verdict are looked at on every sync — so a post
  // that could not be written (writer down) is retried; older history stays available by button.
  const thresholds = { minPnlUsd: settings.trades.minPnlUsd, minRoePct: settings.trades.minRoePct, requireBoth: settings.trades.requireBoth };
  const undecided: TradeRow[] = (await listTrades({ wallet, status: "CLOSED", limit: 60 })).filter((t) => t.post_status === "NONE" && !t.draft_id);
  for (const trade of undecided) {
    const verdict = worthPosting({ status: trade.status, netPnl: trade.net_pnl, roePct: trade.roe_pct, movePct: trade.move_pct }, thresholds);
    if (!verdict.ok) {
      await updateTrade(trade.id, { post_status: "SKIPPED", skip_reason: verdict.reason });
      continue;
    }
    if (!trade.closed_at || Date.now() - trade.closed_at.getTime() > 24 * 3_600_000) continue;
    if (settings.killSwitch || settings.mode === "OFF") continue;
    if ((await tradePostsToday(settings.schedule.timezone)) >= settings.trades.maxPostsPerDay) {
      await updateTrade(trade.id, { skip_reason: `дневной лимит постов о сделках (${settings.trades.maxPostsPerDay}) — пост можно сделать кнопкой` });
      continue;
    }
    try {
      const out = await createTradeDraft(trade.id, { manual: false });
      if (out.kind === "draft") result.drafted++;
    } catch (err) {
      result.error = errorMessage(err);
      break; // the writer is down: one failure speaks for the whole sync, the next one retries
    }
  }
  if (inserted || result.closedNow) await audit("TRADES_SYNCED", `Hyperliquid: новых исполнений ${inserted}, закрыто сделок ${result.closedNow}, постов подготовлено ${result.drafted}`, {}, { wallet: shortWallet(wallet) });
  return result;
}
