export const metadata = { title: "Условия использования — Гудини" };

export default function TermsPage() {
  return (
    <main className="card" style={{ lineHeight: 1.7 }}>
      <h2>Условия использования / Terms of Service</h2>
      <p className="hint">Обновлено: 26 августа 2026</p>
      <p style={{ marginTop: 14 }}>
        Гудини — инструмент для создания и публикации коротких видео. Используя сервис, вы соглашаетесь со
        следующим:
      </p>
      <ol style={{ margin: "12px 0 0 20px", display: "grid", gap: 8 }}>
        <li>Сервис помогает готовить сценарии, монтировать видео и публиковать их на подключённые вами платформы (TikTok, YouTube, Instagram).</li>
        <li>Вы публикуете контент только от своего имени и несёте ответственность за его содержание и соблюдение правил платформ.</li>
        <li>Сервис не претендует на права на ваши видео: весь загруженный и смонтированный контент принадлежит вам.</li>
        <li>Подключение аккаунтов платформ выполняется через официальный OAuth; вы можете отозвать доступ в любой момент в настройках соответствующей платформы.</li>
        <li>Сервис предоставляется «как есть», без гарантий бесперебойной работы.</li>
      </ol>
      <p style={{ marginTop: 14 }}>
        This is a content creation tool: it generates scripts, edits videos and publishes them to the platforms you
        connect via official OAuth. You retain full ownership of your content and can revoke access at any time.
      </p>
      <p className="hint" style={{ marginTop: 14 }}>
        Вопросы: gudov.market@gmail.com
      </p>
    </main>
  );
}
