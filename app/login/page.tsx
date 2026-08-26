"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const query = useSearchParams();

  async function submit() {
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError("Неверный пароль");
        setBusy(false);
        return;
      }
      const next = query.get("next");
      router.push(next && next.startsWith("/") ? next : "/");
      router.refresh();
    } catch {
      setError("Ошибка сети, попробуйте ещё раз");
      setBusy(false);
    }
  }

  return (
    <main style={{ display: "flex", justifyContent: "center", paddingTop: "8vh" }}>
      <div className="card" style={{ maxWidth: 400, width: "100%", textAlign: "center" }}>
        <div className="logo" style={{ fontSize: 32 }}>ГУДИНИ 🎩</div>
        <p className="hint" style={{ margin: "8px 0 20px" }}>
          Вход в студию коротких видео
        </p>
        <input
          type="password"
          placeholder="Пароль"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ textAlign: "center" }}
        />
        {error && <div className="error-box">{error}</div>}
        <button className="btn" style={{ width: "100%", marginTop: 14, justifyContent: "center" }} onClick={submit} disabled={busy || !password}>
          {busy ? <span className="spin" /> : "Войти"}
        </button>
        <p className="hint" style={{ marginTop: 16 }}>
          Пароль выдаёт владелец сайта
        </p>
      </div>
    </main>
  );
}
