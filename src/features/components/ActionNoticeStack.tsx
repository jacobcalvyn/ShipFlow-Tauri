type ActionNoticeLike = {
  id?: string;
  tone: "success" | "error" | "info";
  message: string;
};

type ActionNoticeStackProps = {
  notices: ActionNoticeLike[];
};

export function ActionNoticeStack({ notices }: ActionNoticeStackProps) {
  if (notices.length === 0) {
    return null;
  }

  return (
    <div className="action-toast-stack" aria-live="polite">
      {notices.map((notice) => (
        <div
          key={notice.id ?? notice.message}
          className={`action-notice action-notice-${notice.tone}`}
          role="status"
        >
          {notice.message}
        </div>
      ))}
    </div>
  );
}
