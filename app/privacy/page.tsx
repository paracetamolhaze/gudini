export const metadata = { title: "Политика конфиденциальности — Гудини" };

export default function PrivacyPage() {
  return (
    <main className="card" style={{ lineHeight: 1.7 }}>
      <h2>Политика конфиденциальности / Privacy Policy</h2>
      <p className="hint">Обновлено: 26 августа 2026</p>
      <p style={{ marginTop: 14 }}>Какие данные обрабатывает Гудини и зачем:</p>
      <ol style={{ margin: "12px 0 0 20px", display: "grid", gap: 8 }}>
        <li>
          <b>Видео и сценарии.</b> Загруженные видео и тексты хранятся на сервере только для монтажа и публикации по
          вашей команде. Вы можете удалить проект в любой момент — файлы удаляются вместе с ним.
        </li>
        <li>
          <b>Токены доступа платформ.</b> При подключении TikTok / YouTube / Instagram через официальный OAuth мы
          сохраняем токены доступа исключительно для публикации видео по вашему запросу. Пароли от аккаунтов сервис
          не запрашивает и не видит.
        </li>
        <li>
          <b>Передача третьим лицам.</b> Данные передаются только API самих платформ (для публикации) и ИИ-провайдерам
          (текст темы/сценария — для генерации). Данные не продаются и не используются для рекламы.
        </li>
        <li>
          <b>Отзыв доступа.</b> Отключить сервис можно в настройках безопасности соответствующей платформы (например,
          myaccount.google.com/permissions, настройки TikTok → Безопасность → Управление разрешениями приложений).
        </li>
      </ol>
      <p style={{ marginTop: 14 }}>
        We store your uploaded videos, scripts and OAuth access tokens solely to edit and publish content at your
        request. No data is sold or shared beyond the platform APIs you connect. You can revoke access at any time in
        your platform&apos;s security settings and delete your projects at any moment.
      </p>
      <p className="hint" style={{ marginTop: 14 }}>
        Вопросы: gudov.market@gmail.com
      </p>
    </main>
  );
}
