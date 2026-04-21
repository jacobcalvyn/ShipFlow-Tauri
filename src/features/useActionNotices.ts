import { useCallback, useEffect, useRef, useState } from "react";

export type ActionNotice = {
  id?: string;
  tone: "success" | "error" | "info";
  message: string;
};

function createActionNoticeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useActionNotices(options?: { limit?: number; timeoutMs?: number }) {
  const limit = options?.limit ?? 5;
  const timeoutMs = options?.timeoutMs ?? 2200;
  const [actionNotices, setActionNotices] = useState<ActionNotice[]>([]);
  const actionNoticeTimeoutsRef = useRef(new Map<string, number>());

  useEffect(() => {
    return () => {
      actionNoticeTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      actionNoticeTimeoutsRef.current.clear();
    };
  }, []);

  const showActionNotice = useCallback(
    (notice: ActionNotice) => {
      const noticeId = notice.id || createActionNoticeId();

      setActionNotices((current) => [...current, { ...notice, id: noticeId }].slice(-limit));

      const timeoutId = window.setTimeout(() => {
        setActionNotices((current) =>
          current.filter((currentNotice) => currentNotice.id !== noticeId)
        );
        actionNoticeTimeoutsRef.current.delete(noticeId);
      }, timeoutMs);

      actionNoticeTimeoutsRef.current.set(noticeId, timeoutId);
    },
    [limit, timeoutMs]
  );

  return {
    actionNotices,
    showActionNotice,
  };
}
