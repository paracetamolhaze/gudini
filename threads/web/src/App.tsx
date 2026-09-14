import { useEffect, useState } from "react";
import { get } from "./api";

type Overview = {
  mode: string;
  killSwitch: boolean;
  dryRun: boolean;
  health: { db: { ok: boolean; message: string }; redis: { ok: boolean; message: string }; threads: { ok: boolean; message: string } };
};

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    get<Overview>("/overview")
      .then(setOverview)
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <main className="page">
      <h1>Threads</h1>
      {error && <div className="error-box">{error}</div>}
      {overview && (
        <ul>
          <li>Режим: {overview.mode}</li>
          <li>DRY_RUN: {String(overview.dryRun)}</li>
          <li>Postgres: {overview.health.db.message}</li>
          <li>Redis: {overview.health.redis.message}</li>
          <li>Threads: {overview.health.threads.message}</li>
        </ul>
      )}
    </main>
  );
}
